import { setTimeout as delay } from "node:timers/promises";
import {
  ControlInputQueue,
  ControlInputRejectedError,
  SocketControlWriter,
} from "./control-input-queue.ts";
import { isEmulatorSerial } from "./device-capabilities.ts";
import {
  EmulatorGrpcClient,
  ensureEmulatorGrpcEndpoint,
  IMG_FORMAT_PNG,
  IMG_FORMAT_RGB888,
  IMAGE_TRANSPORT_MMAP,
  type EmuImage,
  type GrpcEndpoint,
  type GrpcImageDecodeEvent,
  type GrpcMessagePacingEvent,
  type GrpcMessagePacingDetail,
  type GrpcScreenshotImageSource,
  type ImageFormatRequest,
  type KeyboardEventRequest,
  type TouchPoint,
} from "./emulator-grpc.ts";
import { execText, type ExecResult } from "./exec.ts";
import {
  H264Encoder,
  assertFfmpegAvailable,
  type H264EncoderInputFormat,
  type H264EncoderOpts,
  type QuarterTurn,
} from "./h264-encoder.ts";
import { H264StartupGate } from "./h264-readiness.ts";
import {
  GrpcMmapScreenshotRegion,
  rgb888MmapRegionBytes,
  type StableMmapRead,
} from "./grpc-mmap.ts";
import {
  compileGesture,
  normalizeTextForControl,
  type Gesture,
} from "./input.ts";
import {
  SCRCPY_DEFAULTS,
  startScrcpyControl,
  type ScrcpyControlSession,
  type VideoFrame,
  type VideoPacket,
} from "./scrcpy.ts";
import { isAbnormalExit, procExitDetail } from "./session-status.ts";
import type {
  EmuSession,
  GrpcCaptureDiagnostics,
  RollingTimingSummary,
  StartEmuSessionOptions,
  StreamFailure,
  StreamMeta,
} from "./stream-session.ts";
import type {
  GrpcImageMode,
  InputSource,
} from "./shared/api-contracts.ts";

export { H264StartupGate } from "./h264-readiness.ts";

// Annex-B does not expose the final access-unit length. Submit one duplicate
// RGB frame only after the observed source cadence goes idle, so ffmpeg emits
// the preceding frame at a real AUD boundary. Parsing stdout merely because it
// went idle is unsafe.
const ACCESS_UNIT_BOUNDARY_IDLE_INTERVALS = 1.5;
const ACCESS_UNIT_BOUNDARY_STARTUP_DELAY_MS = 100;
const ACCESS_UNIT_BOUNDARY_MAX_DELAY_MS = 250;
const ACCESS_UNIT_CADENCE_WINDOW = 8;
const ACCESS_UNIT_CADENCE_OUTLIER_FLOOR_MS = 250;
const ACCESS_UNIT_CADENCE_OUTLIER_MULTIPLIER = 4;
const ACCESS_UNIT_SLOW_CADENCE_SIMILARITY = 1.5;
const ENCODER_WRITE_RETRY_DELAY_MS = 8;
const DEFAULT_IDLE_REPEAT_MS = 500;
const FIRST_FRAME_TIMEOUT_MS = 10_000;
const MAX_QUEUED_PACKET_BYTES = 64 * 1024 * 1024;
const DISPLAY_SIZE_POLL_MS = 2_000;
const MAX_DISPLAY_SIZE_OUTPUT_BYTES = 4_096;
const INPUT_RELEASE_TIMEOUT_MS = 500;
const TOUCH_PRESSURE = 1;
const CAPTURE_DIAGNOSTIC_WINDOW = 240;
// A two-second gap is at least 120 missing slots at the normal 60 FPS target
// and four times the idle-repeat period. Treat the next source frame as the
// start of a new active burst so one static-screen pause cannot depress the
// active capture rate for the next several minutes of a sample-count window.
const CAPTURE_CADENCE_IDLE_RESET_MS = 2_000;

class RollingTimingWindow {
  readonly #values: Float64Array;
  readonly #weights: Float64Array;
  #index = 0;
  #count = 0;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        "diagnostic window capacity must be a positive integer",
      );
    }
    this.#values = new Float64Array(capacity);
    this.#weights = new Float64Array(capacity);
  }

  record(value: number, weight = 1): void {
    if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0)
      return;
    this.#values[this.#index] = value;
    this.#weights[this.#index] = weight;
    this.#index = (this.#index + 1) % this.#values.length;
    if (this.#count < this.#values.length) this.#count++;
  }

  reset(): void {
    this.#index = 0;
    this.#count = 0;
  }

  summary(): RollingTimingSummary | null {
    if (this.#count === 0) return null;
    const entries = Array.from({ length: this.#count }, (_, index) => ({
      value: this.#values[index]!,
      weight: this.#weights[index]!,
    })).sort((left, right) => left.value - right.value);
    const totalWeight = entries.reduce(
      (total, entry) => total + entry.weight,
      0,
    );
    // Use the same upper-median convention as the previous unweighted window,
    // while treating a source interval weighted by N sequence steps as N
    // produced-frame observations without allocating an expanded sample list.
    const at = (quantile: number) => {
      const targetWeight = totalWeight * quantile;
      let cumulativeWeight = 0;
      for (const entry of entries) {
        cumulativeWeight += entry.weight;
        if (cumulativeWeight > targetWeight) return entry.value;
      }
      return entries[entries.length - 1]!.value;
    };
    const round1 = (value: number) => Math.round(value * 10) / 10;
    const latestIndex =
      (this.#index - 1 + this.#values.length) % this.#values.length;
    return {
      windowSamples: this.#count,
      latest: round1(this.#values[latestIndex]!),
      p50: round1(at(0.5)),
      p95: round1(at(0.95)),
      max: round1(entries[entries.length - 1]!.value),
    };
  }

  ratePerSecond(): number | null {
    if (this.#count === 0) return null;
    let weightedTotal = 0;
    let totalWeight = 0;
    for (let index = 0; index < this.#count; index++) {
      const weight = this.#weights[index]!;
      weightedTotal += this.#values[index]! * weight;
      totalWeight += weight;
    }
    if (
      !Number.isFinite(weightedTotal) ||
      weightedTotal <= 0 ||
      totalWeight <= 0
    )
      return null;
    return Math.round((1_000 / (weightedTotal / totalWeight)) * 10) / 10;
  }
}

/** Collects the capture counters exposed through an EmuSession diagnostics snapshot. */
export class GrpcCaptureDiagnosticsTracker {
  readonly #imageMode: GrpcImageMode;
  #rawGrpcMessagesReceived = 0;
  #rawGrpcMessagesEmitted = 0;
  #rawGrpcMessagesCoalesced = 0;
  #usableImages = 0;
  #imagePayloadBytes = 0;
  #transportBytes = 0;
  #grpcMessageBytesReceived = 0;
  #mmapFileBytesRead = 0;
  #mmapReadRetries = 0;
  #mmapTornFramesDropped = 0;
  #sequenceGaps = 0;
  #lastSequence: number | null = null;
  #lastSourceTimestampUs: bigint | null = null;
  #lastRawMessageAtMs: number | null = null;
  #lastUsableImageAtMs: number | null = null;
  #lastFreshEncoderWriteAtMs: number | null = null;
  readonly #sourceTimestampIntervals: RollingTimingWindow;
  readonly #rawMessageReceiveIntervals: RollingTimingWindow;
  readonly #usableImageIntervals: RollingTimingWindow;
  readonly #freshEncoderWriteIntervals: RollingTimingWindow;
  readonly #productionToReceiveLatency: RollingTimingWindow;
  readonly #productionToUsableLatency: RollingTimingWindow;
  readonly #protobufDecodeTime: RollingTimingWindow;
  readonly #sharedReadCopyTime: RollingTimingWindow;
  readonly #cadenceIdleResetMs: number;
  #freshEncoderWriteAttempts = 0;
  #repeatEncoderWriteAttempts = 0;
  #acceptedEncoderWrites = 0;
  #encoderBackpressureRejections = 0;

  constructor(
    imageMode: GrpcImageMode,
    windowCapacity = CAPTURE_DIAGNOSTIC_WINDOW,
    cadenceIdleResetMs = CAPTURE_CADENCE_IDLE_RESET_MS,
  ) {
    if (!Number.isFinite(cadenceIdleResetMs) || cadenceIdleResetMs <= 0) {
      throw new RangeError("cadence idle reset must be a positive number");
    }
    this.#imageMode = imageMode;
    this.#cadenceIdleResetMs = cadenceIdleResetMs;
    this.#sourceTimestampIntervals = new RollingTimingWindow(windowCapacity);
    this.#rawMessageReceiveIntervals = new RollingTimingWindow(windowCapacity);
    this.#usableImageIntervals = new RollingTimingWindow(windowCapacity);
    this.#freshEncoderWriteIntervals = new RollingTimingWindow(windowCapacity);
    this.#productionToReceiveLatency = new RollingTimingWindow(windowCapacity);
    this.#productionToUsableLatency = new RollingTimingWindow(windowCapacity);
    this.#protobufDecodeTime = new RollingTimingWindow(windowCapacity);
    this.#sharedReadCopyTime = new RollingTimingWindow(windowCapacity);
  }

  recordGrpcMessage(
    event: GrpcMessagePacingEvent,
    detail?: GrpcMessagePacingDetail,
    observedAtMs = performance.now(),
  ): void {
    switch (event) {
      case "received":
        this.#rawGrpcMessagesReceived++;
        this.#grpcMessageBytesReceived += detail?.messageBytes ?? 0;
        if (
          this.#lastRawMessageAtMs !== null &&
          observedAtMs > this.#lastRawMessageAtMs
        ) {
          this.#recordCadenceInterval(
            this.#rawMessageReceiveIntervals,
            observedAtMs - this.#lastRawMessageAtMs,
          );
        }
        this.#lastRawMessageAtMs = observedAtMs;
        return;
      case "emitted":
        this.#rawGrpcMessagesEmitted++;
        return;
      case "coalesced":
        this.#rawGrpcMessagesCoalesced++;
        return;
    }
  }

  recordUsableImage(
    image: Pick<EmuImage, "seq" | "timestampUs" | "image">,
    receivedAtMs = Date.now(),
    usableAtMs = receivedAtMs,
  ): void {
    this.#usableImages++;
    this.#transportBytes += image.image.length;
    if (
      this.#lastUsableImageAtMs !== null &&
      usableAtMs > this.#lastUsableImageAtMs
    ) {
      this.#recordCadenceInterval(
        this.#usableImageIntervals,
        usableAtMs - this.#lastUsableImageAtMs,
      );
    }
    this.#lastUsableImageAtMs = usableAtMs;
    let sequenceDelta = 1;
    if (Number.isSafeInteger(image.seq) && image.seq >= 0) {
      if (this.#lastSequence !== null && image.seq > this.#lastSequence) {
        sequenceDelta = image.seq - this.#lastSequence;
      }
      if (this.#lastSequence !== null && image.seq > this.#lastSequence + 1) {
        this.#sequenceGaps += image.seq - this.#lastSequence - 1;
      }
      this.#lastSequence = image.seq;
    }
    if (image.timestampUs <= 0n) return;
    if (
      this.#lastSourceTimestampUs !== null &&
      image.timestampUs > this.#lastSourceTimestampUs
    ) {
      const elapsedMs =
        Number(image.timestampUs - this.#lastSourceTimestampUs) / 1_000;
      this.#recordCadenceInterval(
        this.#sourceTimestampIntervals,
        elapsedMs,
        sequenceDelta,
      );
    }
    this.#lastSourceTimestampUs = image.timestampUs;
    const receivedAtUs = BigInt(Math.round(receivedAtMs * 1_000));
    this.#productionToReceiveLatency.record(
      Number(receivedAtUs - image.timestampUs) / 1_000,
    );
    const usableAtUs = BigInt(Math.round(usableAtMs * 1_000));
    this.#productionToUsableLatency.record(
      Number(usableAtUs - image.timestampUs) / 1_000,
    );
  }

  recordImageDecode(event: GrpcImageDecodeEvent): void {
    this.#protobufDecodeTime.record(event.decodeMs);
  }

  recordMmapRead(read: StableMmapRead): void {
    this.#mmapFileBytesRead += read.bytesRead;
    this.#mmapReadRetries += Math.max(0, read.attempts - 1);
    if (!read.image) this.#mmapTornFramesDropped++;
    this.#sharedReadCopyTime.record(read.readMs);
  }

  recordEncoderWrite(
    repeat: boolean,
    accepted: boolean,
    imagePayloadBytes: number,
    observedAtMs = performance.now(),
  ): void {
    this.#imagePayloadBytes = imagePayloadBytes;
    if (repeat) this.#repeatEncoderWriteAttempts++;
    else this.#freshEncoderWriteAttempts++;
    if (accepted) this.#acceptedEncoderWrites++;
    else this.#encoderBackpressureRejections++;
    if (!repeat && accepted) {
      if (
        this.#lastFreshEncoderWriteAtMs !== null &&
        observedAtMs > this.#lastFreshEncoderWriteAtMs
      ) {
        this.#recordCadenceInterval(
          this.#freshEncoderWriteIntervals,
          observedAtMs - this.#lastFreshEncoderWriteAtMs,
        );
      }
      this.#lastFreshEncoderWriteAtMs = observedAtMs;
    }
  }

  #recordCadenceInterval(
    window: RollingTimingWindow,
    elapsedMs: number,
    weight = 1,
  ): void {
    const intervalPerFrameMs = elapsedMs / weight;
    if (intervalPerFrameMs > this.#cadenceIdleResetMs) {
      window.reset();
      return;
    }
    window.record(intervalPerFrameMs, weight);
  }

  snapshot(): GrpcCaptureDiagnostics {
    return {
      imageMode: this.#imageMode,
      rawGrpcMessagesReceived: this.#rawGrpcMessagesReceived,
      rawGrpcMessagesEmitted: this.#rawGrpcMessagesEmitted,
      rawGrpcMessagesCoalesced: this.#rawGrpcMessagesCoalesced,
      usableImages: this.#usableImages,
      sourceTimestampFps: this.#sourceTimestampIntervals.ratePerSecond(),
      rawMessageReceiveFps: this.#rawMessageReceiveIntervals.ratePerSecond(),
      usableImageFps: this.#usableImageIntervals.ratePerSecond(),
      freshEncoderWriteFps: this.#freshEncoderWriteIntervals.ratePerSecond(),
      sequenceGaps: this.#sequenceGaps,
      imagePayloadBytes: this.#imagePayloadBytes,
      transportBytes: this.#transportBytes,
      grpcMessageBytesReceived: this.#grpcMessageBytesReceived,
      mmapFileBytesRead: this.#mmapFileBytesRead,
      mmapReadRetries: this.#mmapReadRetries,
      mmapTornFramesDropped: this.#mmapTornFramesDropped,
      sourceTimestampIntervalMs: this.#sourceTimestampIntervals.summary(),
      rawMessageReceiveIntervalMs: this.#rawMessageReceiveIntervals.summary(),
      productionToReceiveLatencyMs: this.#productionToReceiveLatency.summary(),
      productionToUsableLatencyMs: this.#productionToUsableLatency.summary(),
      protobufDecodeTimeMs: this.#protobufDecodeTime.summary(),
      sharedReadCopyTimeMs: this.#sharedReadCopyTime.summary(),
      freshEncoderWriteAttempts: this.#freshEncoderWriteAttempts,
      repeatEncoderWriteAttempts: this.#repeatEncoderWriteAttempts,
      acceptedEncoderWrites: this.#acceptedEncoderWrites,
      encoderBackpressureRejections: this.#encoderBackpressureRejections,
    };
  }
}

const ANDROID_KEYCODE_TO_EVDEV: Record<number, number> = {
  19: 103,
  20: 108,
  21: 105,
  22: 106,
  24: 115,
  25: 114,
  61: 15,
  66: 28,
  67: 14,
  92: 104,
  93: 109,
  111: 1,
  112: 111,
  122: 102,
  123: 107,
  164: 113,
};

const ANDROID_PRINTABLE_KEYCODE_TO_W3C: Record<number, string> = {
  55: ",",
  56: ".",
  62: " ",
  68: "`",
  69: "-",
  70: "=",
  71: "[",
  72: "]",
  73: "\\",
  74: ";",
  75: "'",
  76: "/",
  77: "@",
  81: "+",
};

const ANDROID_SPECIAL_KEYCODE_TO_W3C: Record<number, string> = {
  3: "GoHome",
  4: "GoBack",
  26: "Power",
  187: "AppSwitch",
};

const ANDROID_META = {
  shift: 0x0000_0001,
  alt: 0x0000_0002,
  altLeft: 0x0000_0010,
  altRight: 0x0000_0020,
  shiftLeft: 0x0000_0040,
  shiftRight: 0x0000_0080,
  ctrl: 0x0000_1000,
  ctrlLeft: 0x0000_2000,
  ctrlRight: 0x0000_4000,
  meta: 0x0001_0000,
  metaLeft: 0x0002_0000,
  metaRight: 0x0004_0000,
} as const;

const SUPPORTED_ANDROID_META_MASK = Object.values(ANDROID_META).reduce(
  (mask, value) => mask | value,
  0,
);

type AndroidKeyGesture = Extract<Gesture, { type: "key" }>;

function modifierKeyRequests(metaState: number): KeyboardEventRequest[] {
  const unsupported = metaState & ~SUPPORTED_ANDROID_META_MASK;
  if (unsupported !== 0) {
    throw new ControlInputRejectedError(
      `grpc-screenshot cannot encode Android key metaState bits 0x${unsupported.toString(16)}`,
    );
  }

  const modifiers: KeyboardEventRequest[] = [];
  const addGroup = (
    generic: number,
    left: number,
    right: number,
    leftEvdev: number,
    rightEvdev: number,
  ) => {
    const hasLeft = (metaState & left) !== 0;
    const hasRight = (metaState & right) !== 0;
    if (hasLeft) modifiers.push({ evdev: leftEvdev, eventType: "down" });
    if (hasRight) modifiers.push({ evdev: rightEvdev, eventType: "down" });
    if (!hasLeft && !hasRight && (metaState & generic) !== 0) {
      modifiers.push({ evdev: leftEvdev, eventType: "down" });
    }
  };

  addGroup(
    ANDROID_META.shift,
    ANDROID_META.shiftLeft,
    ANDROID_META.shiftRight,
    42,
    54,
  );
  addGroup(
    ANDROID_META.ctrl,
    ANDROID_META.ctrlLeft,
    ANDROID_META.ctrlRight,
    29,
    97,
  );
  addGroup(
    ANDROID_META.alt,
    ANDROID_META.altLeft,
    ANDROID_META.altRight,
    56,
    100,
  );
  addGroup(
    ANDROID_META.meta,
    ANDROID_META.metaLeft,
    ANDROID_META.metaRight,
    125,
    126,
  );
  return modifiers;
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(fallback, "AbortError");
}

function throwIfAborted(signal: AbortSignal, fallback: string): void {
  if (signal.aborted) throw abortReason(signal, fallback);
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await delay(Math.max(0, ms), undefined, { signal });
}

function commandFailure(
  description: string,
  result: ExecResult<string>,
): Error {
  const detail =
    result.stderr.trim() ||
    result.stdout.trim() ||
    result.error?.message ||
    `status ${result.status ?? "unknown"}`;
  return new Error(`${description}: ${detail}`);
}

async function runPowerCommand(
  serial: string,
  action: "sleep" | "wakeup",
  signal: AbortSignal,
): Promise<void> {
  const result = await execText(
    "adb",
    ["-s", serial, "shell", "cmd", "power", action],
    { timeout: 5_000, signal, lane: "interactive" },
  );
  if (result.status !== 0) {
    throw commandFailure(`could not ${action} ${serial}`, result);
  }
}

async function isDeviceAwake(
  serial: string,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await execText(
    "adb",
    ["-s", serial, "shell", "dumpsys", "power"],
    { timeout: 5_000, signal, lane: "interactive" },
  );
  if (result.status !== 0) {
    throw commandFailure(`could not read power state for ${serial}`, result);
  }
  return /mWakefulness=Awake\b/.test(result.stdout);
}

export function androidKeycodeToW3c(keycode: number): string | null {
  const named = ANDROID_PRINTABLE_KEYCODE_TO_W3C[keycode];
  if (named) return named;
  if (keycode >= 7 && keycode <= 16) return String(keycode - 7);
  if (keycode >= 29 && keycode <= 54) {
    return String.fromCharCode(97 + keycode - 29);
  }
  return null;
}

/** Translate scrcpy's Android key gesture semantics to emulator key events. */
export function androidKeyGestureToKeyboardEvents(
  gesture: AndroidKeyGesture,
): KeyboardEventRequest[] {
  const eventType: NonNullable<KeyboardEventRequest["eventType"]> =
    gesture.action ?? "press";
  const special = ANDROID_SPECIAL_KEYCODE_TO_W3C[gesture.keycode];
  const evdev = ANDROID_KEYCODE_TO_EVDEV[gesture.keycode];
  const printable = androidKeycodeToW3c(gesture.keycode);
  const key: KeyboardEventRequest | null = special
    ? { key: special, eventType }
    : evdev
      ? { evdev, eventType }
      : printable
        ? { key: printable, eventType }
        : null;
  if (!key) {
    throw new ControlInputRejectedError(
      `Android keycode ${gesture.keycode} is unsupported by grpc-screenshot`,
    );
  }

  const modifiers = modifierKeyRequests(gesture.metaState ?? 0);
  if (modifiers.length === 0) return [key];
  const releaseModifiers = [...modifiers]
    .reverse()
    .map((modifier) => ({ ...modifier, eventType: "up" as const }));
  if (eventType === "down") return [...modifiers, key];
  if (eventType === "up") return [key, ...releaseModifiers];
  return [...modifiers, key, ...releaseModifiers];
}

export function isUsableRgbFrame(image: EmuImage): boolean {
  return (
    image.format === IMG_FORMAT_RGB888 &&
    image.width > 0 &&
    image.height > 0 &&
    Number.isSafeInteger(image.width) &&
    Number.isSafeInteger(image.height) &&
    image.image.length === image.width * image.height * 3
  );
}

export function readMmapImageNotification(
  notification: EmuImage,
  readFrame: (byteLength: number) => StableMmapRead,
): { image: EmuImage | null; read: StableMmapRead | null } {
  // AEMU uses a single metadata-only 0x0 image to signal that a display has
  // become inactive. It is an idle marker, not a malformed MMAP frame.
  if (
    notification.width === 0 &&
    notification.height === 0 &&
    notification.image.length === 0
  ) {
    return { image: null, read: null };
  }
  if (
    notification.format !== IMG_FORMAT_RGB888 ||
    notification.width <= 0 ||
    notification.height <= 0 ||
    !Number.isSafeInteger(notification.width) ||
    !Number.isSafeInteger(notification.height) ||
    notification.image.length !== 0
  ) {
    throw new Error(
      "emulator MMAP screenshot notification must contain RGB888 metadata and no in-band image bytes",
    );
  }
  const read = readFrame(
    rgb888MmapRegionBytes(notification.width, notification.height),
  );
  if (!read.image) return { image: null, read };
  const image = { ...notification, image: read.image };
  if (!isUsableRgbFrame(image)) {
    throw new Error(
      "emulator MMAP screenshot produced an invalid RGB888 frame",
    );
  }
  return { image, read };
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function isUsablePngFrame(image: EmuImage): boolean {
  return (
    image.format === IMG_FORMAT_PNG &&
    image.width > 0 &&
    image.height > 0 &&
    Number.isSafeInteger(image.width) &&
    Number.isSafeInteger(image.height) &&
    image.image.length >= PNG_SIGNATURE.length &&
    image.image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

export type GrpcImageModeBehavior = {
  encoderInputFormat: H264EncoderInputFormat;
  predecodeMaxFps: number | undefined;
  needsEncoderFollowUp(repeat: boolean, encoderHasOutput: boolean): boolean;
};

/** Select the immutable encoder and pacing policy for one gRPC image mode. */
export function grpcImageModeBehavior(
  imageMode: GrpcImageMode,
  maxFps: number,
): GrpcImageModeBehavior {
  if (imageMode === "png") {
    return {
      encoderInputFormat: "png",
      predecodeMaxFps: maxFps,
      needsEncoderFollowUp: (repeat, encoderHasOutput) =>
        !repeat || !encoderHasOutput,
    };
  }
  return {
    encoderInputFormat: "rgb24",
    predecodeMaxFps: undefined,
    needsEncoderFollowUp: (repeat) => !repeat,
  };
}

export type GrpcMmapNotificationSchedulerClock = {
  now(): number;
  queueMicrotask(callback: () => void): void;
};

type PendingMmapNotification = {
  image: EmuImage;
  receivedAtMs: number;
};

const DEFAULT_MMAP_NOTIFICATION_CLOCK: GrpcMmapNotificationSchedulerClock = {
  now: () => performance.now(),
  queueMicrotask: (callback) => queueMicrotask(callback),
};

/**
 * Rate-limit expensive MMAP snapshots after protobuf metadata is decoded.
 *
 * The shared region contains only its newest generation, so delaying protobuf
 * decode would pair stale metadata with newer pixels. Instead, one synchronous
 * decode turn is coalesced in a microtask and retains only its newest decoded
 * metadata. The callback must copy the shared region before returning.
 * Notifications received while the pacing slot is closed are dropped instead
 * of retained for a trailing snapshot: the emulator owns and continuously
 * reuses the shared region, so delayed metadata cannot safely be associated
 * with the pixels that will be present later.
 */
export class GrpcMmapNotificationScheduler {
  readonly #frameIntervalMs: number;
  readonly #consume: (image: EmuImage, receivedAtMs: number) => void;
  readonly #onPacingEvent: (
    event: Extract<GrpcMessagePacingEvent, "emitted" | "coalesced">,
  ) => void;
  readonly #onError: (error: unknown) => void;
  readonly #clock: GrpcMmapNotificationSchedulerClock;
  readonly #signal: AbortSignal | undefined;
  #nextEmitAtMs: number | null = null;
  #pending: PendingMmapNotification | null = null;
  #microtaskQueued = false;
  #closed = false;

  constructor(options: {
    maxFps: number;
    consume: (image: EmuImage, receivedAtMs: number) => void;
    onPacingEvent?: (
      event: Extract<GrpcMessagePacingEvent, "emitted" | "coalesced">,
    ) => void;
    onError?: (error: unknown) => void;
    signal?: AbortSignal;
    clock?: GrpcMmapNotificationSchedulerClock;
  }) {
    if (!Number.isFinite(options.maxFps) || options.maxFps <= 0) {
      throw new RangeError("MMAP notification maxFps must be positive");
    }
    this.#frameIntervalMs = 1_000 / options.maxFps;
    this.#consume = options.consume;
    this.#onPacingEvent = options.onPacingEvent ?? (() => {});
    this.#onError = options.onError ?? (() => {});
    this.#clock = options.clock ?? DEFAULT_MMAP_NOTIFICATION_CLOCK;
    this.#signal = options.signal;
    if (this.#signal?.aborted) this.#closed = true;
    else this.#signal?.addEventListener("abort", this.#onAbort, { once: true });
  }

  push(image: EmuImage, receivedAtMs: number): void {
    if (this.#closed) return;
    const now = this.#clock.now();
    if (this.#nextEmitAtMs !== null && now < this.#nextEmitAtMs) {
      this.#onPacingEvent("coalesced");
      return;
    }
    // Defer only to the end of this decode turn: one HTTP/2 data chunk can
    // contain a backlog of notifications, and the shared region already
    // contains the newest generation. A microtask remains prompt for the
    // first frame while allowing that synchronous backlog to coalesce.
    if (this.#pending) this.#onPacingEvent("coalesced");
    this.#pending = { image, receivedAtMs };
    this.#queuePromptFlush();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending = null;
    this.#microtaskQueued = false;
    this.#signal?.removeEventListener("abort", this.#onAbort);
  }

  readonly #onAbort = () => this.close();

  #queuePromptFlush(): void {
    if (this.#microtaskQueued) return;
    this.#microtaskQueued = true;
    this.#clock.queueMicrotask(() => {
      this.#microtaskQueued = false;
      if (this.#closed || !this.#pending) return;
      const now = this.#clock.now();
      if (this.#nextEmitAtMs !== null && now < this.#nextEmitAtMs) {
        this.#pending = null;
        this.#onPacingEvent("coalesced");
        return;
      }
      const pending = this.#pending;
      this.#pending = null;
      this.#emit(pending, now);
    });
  }

  #emit(notification: PendingMmapNotification, now: number): void {
    if (this.#closed) return;
    this.#nextEmitAtMs = now + this.#frameIntervalMs;
    try {
      this.#onPacingEvent("emitted");
      // Intentionally synchronous: this is the ownership boundary where the
      // reused MMAP pixels become a client-owned snapshot.
      this.#consume(notification.image, notification.receivedAtMs);
    } catch (error) {
      this.close();
      this.#onError(error);
      return;
    }
  }
}

type GrpcImageCaptureTransport = GrpcImageModeBehavior & {
  streamFormat: ImageFormatRequest;
  push(
    notification: EmuImage,
    source: GrpcScreenshotImageSource,
    receivedAtMs: number,
  ): void;
  recordRawPacingEvent(
    event: GrpcMessagePacingEvent,
    detail: GrpcMessagePacingDetail,
  ): void;
  stop(): void;
  close(): Promise<void>;
};

function createGrpcImageCaptureTransport(options: {
  imageMode: GrpcImageMode;
  maxFps: number;
  maxSize: number;
  probe: Pick<EmuImage, "width" | "height">;
  signal: AbortSignal;
  diagnostics: GrpcCaptureDiagnosticsTracker;
  consume(
    image: EmuImage,
    source: GrpcScreenshotImageSource,
    receivedAtMs: number,
  ): void;
  onError(error: unknown): void;
}): GrpcImageCaptureTransport {
  const behavior = grpcImageModeBehavior(options.imageMode, options.maxFps);
  if (options.imageMode === "png") {
    let closed = false;
    return {
      ...behavior,
      streamFormat: {
        format: IMG_FORMAT_PNG,
        width: options.maxSize,
        height: options.maxSize,
      },
      push(notification, source, receivedAtMs) {
        if (!closed && isUsablePngFrame(notification)) {
          options.consume(notification, source, receivedAtMs);
        }
      },
      recordRawPacingEvent(event, detail) {
        options.diagnostics.recordGrpcMessage(event, detail);
      },
      stop() {
        closed = true;
      },
      async close() {
        closed = true;
      },
    };
  }

  const captureExtent =
    options.maxSize > 0
      ? options.maxSize
      : Math.max(options.probe.width, options.probe.height);
  // A reusable MMAP file must be sized before streamScreenshot starts, so
  // native-size mode resolves zero once from the startup probe. The square
  // extent handles rotation, but a later display growth beyond this native
  // startup cap requires restarting capture; it never falls back to PNG.
  const region = GrpcMmapScreenshotRegion.create(
    rgb888MmapRegionBytes(captureExtent, captureExtent),
  );
  const consumeNotification = (
    notification: EmuImage,
    source: GrpcScreenshotImageSource,
    receivedAtMs: number,
  ) => {
    const result = readMmapImageNotification(notification, (byteLength) =>
      region.readFrame(byteLength),
    );
    if (result.read) options.diagnostics.recordMmapRead(result.read);
    if (result.image) options.consume(result.image, source, receivedAtMs);
  };
  const scheduler = new GrpcMmapNotificationScheduler({
    maxFps: options.maxFps,
    signal: options.signal,
    consume: (notification, receivedAtMs) =>
      consumeNotification(notification, "stream", receivedAtMs),
    onPacingEvent: (event) => options.diagnostics.recordGrpcMessage(event),
    onError: options.onError,
  });
  return {
    ...behavior,
    streamFormat: {
      format: IMG_FORMAT_RGB888,
      width: captureExtent,
      height: captureExtent,
      transport: {
        channel: IMAGE_TRANSPORT_MMAP,
        handle: region.handle,
      },
    },
    push(notification, source, receivedAtMs) {
      // Stream notifications are paced against the reused region. A bounded
      // inactivity probe is already outside normal cadence and must retain its
      // source identity so it does not train the stream boundary estimator.
      if (source === "stream") scheduler.push(notification, receivedAtMs);
      else consumeNotification(notification, source, receivedAtMs);
    },
    recordRawPacingEvent(event, detail) {
      // MMAP decodes every lightweight notification. The post-decode scheduler
      // records which notifications were selected or coalesced for snapshots.
      if (event === "received") {
        options.diagnostics.recordGrpcMessage(event, detail);
      }
    },
    stop: () => scheduler.close(),
    async close() {
      scheduler.close();
      await region.close();
    },
  };
}

export type GrpcDisplayGeometry = {
  encodedSize: { width: number; height: number };
  touchSize: { width: number; height: number };
  mapTouch(unitX: number, unitY: number): { x: number; y: number };
};

export function resolveGrpcDisplayGeometry(options: {
  inputWidth: number;
  inputHeight: number;
  nativeWidth: number;
  nativeHeight: number;
}): GrpcDisplayGeometry {
  const croppedWidth = options.inputWidth - (options.inputWidth % 2);
  const croppedHeight = options.inputHeight - (options.inputHeight % 2);
  const encodedSize = { width: croppedWidth, height: croppedHeight };
  const touchSize = {
    width: options.nativeWidth,
    height: options.nativeHeight,
  };

  const toPixel = (unit: number, size: number) =>
    Math.max(0, Math.min(size - 1, Math.round(unit * size)));

  return {
    encodedSize,
    touchSize,
    mapTouch(unitX, unitY) {
      // Emulator screenshots are already oriented and touch coordinates use
      // that same physical top-left coordinate space.
      return {
        x: toPixel(unitX, touchSize.width),
        y: toPixel(unitY, touchSize.height),
      };
    },
  };
}

export class GrpcFrameWritePacer {
  readonly #frameIntervalMs: number;
  #nextFreshWriteAt = 0;

  constructor(frameIntervalMs: number) {
    if (!Number.isFinite(frameIntervalMs) || frameIntervalMs <= 0) {
      throw new RangeError("frameIntervalMs must be a positive number");
    }
    this.#frameIntervalMs = frameIntervalMs;
  }

  reset(now: number): void {
    this.#nextFreshWriteAt = now;
  }

  recordWrite(now: number, repeat: boolean, accepted = true): void {
    if (repeat || !accepted) return;
    this.#nextFreshWriteAt = Math.max(
      this.#nextFreshWriteAt + this.#frameIntervalMs,
      now + this.#frameIntervalMs,
    );
  }

  waitMs(now: number): number {
    return Math.max(0, this.#nextFreshWriteAt - now);
  }
}

export class GrpcAccessUnitBoundaryCadence {
  readonly #minimumIntervalMs: number;
  #lastFreshImageAt: number | null = null;
  readonly #freshImageIntervals: number[] = [];
  #slowIntervalCandidate: number | null = null;

  constructor(minimumIntervalMs: number) {
    if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs <= 0) {
      throw new RangeError("minimumIntervalMs must be a positive number");
    }
    this.#minimumIntervalMs = minimumIntervalMs;
  }

  recordFreshImage(now: number): void {
    if (this.#lastFreshImageAt !== null) {
      const interval = now - this.#lastFreshImageAt;
      if (interval > 0) {
        const observedInterval = this.#observedInterval();
        const outlierThreshold = Math.max(
          ACCESS_UNIT_CADENCE_OUTLIER_FLOOR_MS,
          (observedInterval ?? 0) * ACCESS_UNIT_CADENCE_OUTLIER_MULTIPLIER,
        );
        if (interval > outlierThreshold) {
          if (
            observedInterval === null &&
            this.#slowIntervalCandidate !== null &&
            Math.max(interval, this.#slowIntervalCandidate) /
              Math.min(interval, this.#slowIntervalCandidate) <=
              ACCESS_UNIT_SLOW_CADENCE_SIMILARITY
          ) {
            this.#pushInterval(this.#slowIntervalCandidate);
            this.#pushInterval(interval);
            this.#slowIntervalCandidate = null;
          } else if (observedInterval === null) {
            this.#slowIntervalCandidate = interval;
          }
        } else {
          this.#slowIntervalCandidate = null;
          this.#pushInterval(interval);
        }
      }
    }
    this.#lastFreshImageAt = now;
  }

  boundaryDelayMs(): number {
    const observedInterval = this.#observedInterval();
    if (observedInterval === null) {
      return ACCESS_UNIT_BOUNDARY_STARTUP_DELAY_MS;
    }
    return Math.min(
      ACCESS_UNIT_BOUNDARY_MAX_DELAY_MS,
      Math.max(this.#minimumIntervalMs, observedInterval) *
        ACCESS_UNIT_BOUNDARY_IDLE_INTERVALS,
    );
  }

  #pushInterval(interval: number): void {
    this.#freshImageIntervals.push(interval);
    if (this.#freshImageIntervals.length > ACCESS_UNIT_CADENCE_WINDOW) {
      this.#freshImageIntervals.shift();
    }
  }

  #observedInterval(): number | null {
    if (this.#freshImageIntervals.length === 0) return null;
    const sorted = [...this.#freshImageIntervals].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[middle]!;
  }
}

type GrpcInputClient = {
  sendTouch(points: TouchPoint[], signal?: AbortSignal): Promise<void>;
  sendKey(event: KeyboardEventRequest, signal?: AbortSignal): Promise<void>;
};

function keyIdentity(event: KeyboardEventRequest): string | null {
  if (event.evdev !== undefined) return `evdev:${event.evdev}`;
  if (event.key) return `key:${event.key}`;
  return null;
}

/** Tracks possibly-sent downs so cancellation can finish with explicit ups. */
export class GrpcInputState {
  readonly #client: GrpcInputClient;
  readonly #activeTouches = new Map<number, TouchPoint>();
  readonly #activeKeys = new Map<string, KeyboardEventRequest>();
  #tail: Promise<void> = Promise.resolve();

  constructor(client: GrpcInputClient) {
    this.#client = client;
  }

  sendTouch(points: TouchPoint[], signal: AbortSignal): Promise<void> {
    return this.#enqueue(async () => {
      for (const point of points) {
        if (point.pressure > 0)
          this.#activeTouches.set(point.identifier, point);
      }
      await this.#client.sendTouch(points, signal);
      for (const point of points) {
        if (point.pressure === 0) this.#activeTouches.delete(point.identifier);
      }
    });
  }

  sendKey(event: KeyboardEventRequest, signal: AbortSignal): Promise<void> {
    return this.#enqueue(async () => {
      const identity = keyIdentity(event);
      if (identity && event.eventType === "down") {
        this.#activeKeys.set(identity, event);
      }
      await this.#client.sendKey(event, signal);
      if (identity && event.eventType === "up") {
        this.#activeKeys.delete(identity);
      }
    });
  }

  releaseAll(signal: AbortSignal): Promise<void> {
    return this.#enqueue(async () => {
      let firstFailure: unknown;
      const touches = [...this.#activeTouches.values()].map((point) => ({
        ...point,
        pressure: 0,
      }));
      if (touches.length > 0) {
        try {
          await this.#client.sendTouch(touches, signal);
          for (const point of touches) {
            this.#activeTouches.delete(point.identifier);
          }
        } catch (error) {
          firstFailure = error;
        }
      }

      for (const [identity, event] of [...this.#activeKeys]) {
        try {
          await this.#client.sendKey(
            { ...event, eventType: "up", text: undefined },
            signal,
          );
          this.#activeKeys.delete(identity);
        } catch (error) {
          firstFailure ??= error;
        }
      }
      if (firstFailure) throw firstFailure;
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

/**
 * The emulator translates KeyboardEvent.text through evdev and may silently
 * ignore arbitrary Unicode, so keep this path intentionally ASCII-only:
 * https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-master-dev/android/android-grpc/emulator_controller.proto
 *
 * A future Unicode implementation could use the emulator clipboard mechanism:
 * https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-master-dev/android/android-grpc/services/emulator-controller/server/src/android/emulation/control/clipboard/Clipboard.cpp
 */
export function normalizeGrpcText(text: string): string {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0x7f) {
      throw new ControlInputRejectedError(
        "grpc-screenshot supports ASCII text only",
      );
    }
  }
  return normalizeTextForControl(text);
}

export function normalizeGrpcGestureText(
  gesture: Extract<Gesture, { type: "text" }>,
): string {
  return normalizeGrpcText(gesture.text);
}

export function parseDisplaySizeSignal(output: string): string {
  if (Buffer.byteLength(output) > MAX_DISPLAY_SIZE_OUTPUT_BYTES) {
    throw new Error(
      `display size response exceeds ${MAX_DISPLAY_SIZE_OUTPUT_BYTES} byte limit`,
    );
  }
  const sizes = new Map<string, string>();
  for (const match of output.matchAll(
    /\b(Physical|Override) size:\s*(\d{1,5})x(\d{1,5})\b/g,
  )) {
    const width = Number(match[2]);
    const height = Number(match[3]);
    if (width <= 0 || height <= 0) continue;
    sizes.set(match[1]!.toLowerCase(), `${width}x${height}`);
  }
  if (sizes.size === 0) {
    throw new Error("could not parse emulator display size");
  }
  return ["physical", "override"]
    .flatMap((kind) => {
      const size = sizes.get(kind);
      return size ? [`${kind}:${size}`] : [];
    })
    .join(";");
}

export class GrpcNativeTouchGeometryMonitor {
  readonly #readDisplaySizeSignal: (signal: AbortSignal) => Promise<string>;
  readonly #readNativeImage: (
    signal: AbortSignal,
  ) => Promise<{ width: number; height: number; rotation?: number }>;
  readonly #onNativeSize: (size: { width: number; height: number }) => void;
  #displaySizeSignal: string | null;
  #pollTask: Promise<void> | null = null;
  #forcePending = false;
  #forceGeneration = 0;

  constructor(options: {
    initialDisplaySizeSignal: string | null;
    readDisplaySizeSignal: (signal: AbortSignal) => Promise<string>;
    readNativeImage: (
      signal: AbortSignal,
    ) => Promise<{ width: number; height: number; rotation?: number }>;
    onNativeSize: (size: { width: number; height: number }) => void;
  }) {
    this.#displaySizeSignal = options.initialDisplaySizeSignal;
    this.#readDisplaySizeSignal = options.readDisplaySizeSignal;
    this.#readNativeImage = options.readNativeImage;
    this.#onNativeSize = options.onNativeSize;
  }

  poll(signal: AbortSignal, force = false): Promise<void> {
    if (force) {
      this.#forcePending = true;
      this.#forceGeneration++;
    }
    if (this.#pollTask) return this.#pollTask;
    const task = this.#drainPolls(signal).finally(() => {
      if (this.#pollTask === task) this.#pollTask = null;
    });
    this.#pollTask = task;
    return task;
  }

  async #drainPolls(signal: AbortSignal): Promise<void> {
    let first = true;
    while (first || this.#forcePending) {
      first = false;
      const force = this.#forcePending;
      this.#forcePending = false;
      const generation = this.#forceGeneration;
      try {
        await this.#pollOnce(signal, force, generation);
      } catch (error) {
        if (!this.#forcePending) throw error;
      }
    }
  }

  async #pollOnce(
    signal: AbortSignal,
    force: boolean,
    generation: number,
  ): Promise<void> {
    throwIfAborted(signal, "display size refresh aborted");
    const nextSignal = await this.#readDisplaySizeSignal(signal);
    if (!force && nextSignal === this.#displaySizeSignal) return;
    const image = await this.#readNativeImage(signal);
    throwIfAborted(signal, "display size refresh aborted");
    if (generation !== this.#forceGeneration) return;
    if (
      !Number.isSafeInteger(image.width) ||
      !Number.isSafeInteger(image.height) ||
      image.width <= 0 ||
      image.height <= 0
    ) {
      throw new Error("emulator returned invalid native touch dimensions");
    }
    this.#onNativeSize({ width: image.width, height: image.height });
    this.#displaySizeSignal = nextSignal;
  }
}

export type GrpcSessionDependencies = {
  readDisplaySizeSignal?: (
    serial: string,
    signal: AbortSignal,
  ) => Promise<string>;
  startScrcpyControl?: typeof startScrcpyControl;
  runtime?: Partial<GrpcSessionRuntime>;
};

export type GrpcSessionClient = {
  getScreenshot(
    format: ImageFormatRequest,
    signal?: AbortSignal,
  ): Promise<EmuImage>;
  streamScreenshot(
    format: ImageFormatRequest,
    onImage: (
      image: EmuImage,
      source: GrpcScreenshotImageSource,
      receivedAtMs: number,
    ) => void,
    signal: AbortSignal,
    options?: {
      maxFps?: number;
      onPacingEvent?: (
        event: GrpcMessagePacingEvent,
        detail: GrpcMessagePacingDetail,
      ) => void;
      onDecode?: (event: GrpcImageDecodeEvent) => void;
    },
  ): Promise<void>;
  sendTouch(points: TouchPoint[], signal?: AbortSignal): Promise<void>;
  sendKey(event: KeyboardEventRequest, signal?: AbortSignal): Promise<void>;
  onSessionError(listener: (error: Error) => void): () => void;
  close(): void;
};

export type GrpcSessionEncoder = {
  readonly width: number;
  readonly height: number;
  readonly quarterTurn: QuarterTurn;
  write(rgb: Buffer, ptsUs: bigint): boolean;
  close(): Promise<void>;
};

export type GrpcSessionRuntime = {
  assertFfmpeg(signal: AbortSignal): Promise<void>;
  ensureEndpoint(serial: string, signal: AbortSignal): Promise<GrpcEndpoint>;
  createClient(endpoint: GrpcEndpoint): GrpcSessionClient;
  createEncoder(options: H264EncoderOpts): GrpcSessionEncoder;
  isDeviceAwake(serial: string, signal: AbortSignal): Promise<boolean>;
  wakeDevice(serial: string, signal: AbortSignal): Promise<void>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
};

export type GrpcEncoderRestart = {
  announceSize: boolean;
  clearPending: boolean;
};

type SessionPacket = Extract<VideoPacket, { type: "session" }>;
type FramePacket = Extract<VideoPacket, { type: "frame" }>;
export type GrpcPacketQueuePushResult = {
  queued: boolean;
  needsKeyFrame: boolean;
};

const PACKET_QUEUED: GrpcPacketQueuePushResult = {
  queued: true,
  needsKeyFrame: false,
};
const PACKET_DROPPED: GrpcPacketQueuePushResult = {
  queued: false,
  needsKeyFrame: false,
};

function queuedPacketBytes(packet: VideoPacket): number {
  return packet.type === "frame" ? packet.data.length : 16;
}

function lastKeyFrameIndex(packets: readonly VideoPacket[]): number {
  for (let index = packets.length - 1; index >= 0; index--) {
    const packet = packets[index]!;
    if (packet.type === "frame" && packet.isKey) return index;
  }
  return -1;
}

function lastSessionPacket(
  packets: readonly VideoPacket[],
  end = packets.length,
): SessionPacket | null {
  for (let index = end - 1; index >= 0; index--) {
    const packet = packets[index]!;
    if (packet.type === "session") return packet;
  }
  return null;
}

/** A byte-bounded queue that only resumes readers from decodable H.264 state. */
export class GrpcVideoPacketQueue {
  readonly #maxBytes: number;
  #packets: VideoPacket[] = [];
  #byteLength = 0;
  #latestConfig: FramePacket | null = null;
  #configByKeyFrame = new WeakMap<FramePacket, FramePacket>();
  #pendingSession: SessionPacket | null = null;
  #awaitingKeyFrame = false;

  constructor(maxBytes = MAX_QUEUED_PACKET_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
    this.#maxBytes = maxBytes;
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  push(packet: VideoPacket): GrpcPacketQueuePushResult {
    if (packet.type === "frame" && packet.isConfig) {
      this.#latestConfig = packet;
    }
    if (packet.type === "frame" && packet.isKey && this.#latestConfig) {
      this.#configByKeyFrame.set(packet, this.#latestConfig);
    }

    if (this.#awaitingKeyFrame) {
      if (packet.type === "session") {
        this.#pendingSession = packet;
        return PACKET_DROPPED;
      }
      if (packet.isConfig || !packet.isKey) return PACKET_DROPPED;
      return this.#resumeAtKeyFrame(packet);
    }

    this.#packets.push(packet);
    this.#byteLength += queuedPacketBytes(packet);
    if (this.#byteLength <= this.#maxBytes) return PACKET_QUEUED;

    const keyIndex = lastKeyFrameIndex(this.#packets);
    const keyFrame = this.#packets[keyIndex];
    const keyFrameConfig =
      keyFrame?.type === "frame"
        ? this.#configByKeyFrame.get(keyFrame)
        : undefined;
    if (keyIndex < 0 || !keyFrameConfig) {
      return this.#dropUntilKeyFrame();
    }

    const session = lastSessionPacket(this.#packets, keyIndex);
    const suffix = this.#packets.slice(keyIndex);
    const retained = [...(session ? [session] : []), keyFrameConfig, ...suffix];
    const retainedBytes = retained.reduce(
      (total, queued) => total + queuedPacketBytes(queued),
      0,
    );
    if (retainedBytes > this.#maxBytes) {
      throw new Error(
        `decodable gRPC H.264 queue exceeds ${this.#maxBytes} byte limit`,
      );
    }
    this.#packets = retained;
    this.#byteLength = retainedBytes;
    return PACKET_QUEUED;
  }

  shift(): VideoPacket | undefined {
    const packet = this.#packets.shift();
    if (packet) this.#byteLength -= queuedPacketBytes(packet);
    return packet;
  }

  clear(): void {
    this.#packets = [];
    this.#byteLength = 0;
    this.#latestConfig = null;
    this.#configByKeyFrame = new WeakMap<FramePacket, FramePacket>();
    this.#pendingSession = null;
    this.#awaitingKeyFrame = false;
  }

  #dropUntilKeyFrame(): GrpcPacketQueuePushResult {
    this.#pendingSession = lastSessionPacket(this.#packets);
    this.#packets = [];
    this.#byteLength = 0;
    this.#awaitingKeyFrame = true;
    return { queued: false, needsKeyFrame: true };
  }

  #resumeAtKeyFrame(keyFrame: FramePacket): GrpcPacketQueuePushResult {
    if (!this.#latestConfig) return PACKET_DROPPED;
    const resumed = [
      ...(this.#pendingSession ? [this.#pendingSession] : []),
      this.#latestConfig,
      keyFrame,
    ];
    const resumedBytes = resumed.reduce(
      (total, queued) => total + queuedPacketBytes(queued),
      0,
    );
    if (resumedBytes > this.#maxBytes) {
      throw new Error(
        `decodable gRPC H.264 queue exceeds ${this.#maxBytes} byte limit`,
      );
    }
    this.#packets = resumed;
    this.#byteLength = resumedBytes;
    this.#pendingSession = null;
    this.#awaitingKeyFrame = false;
    return PACKET_QUEUED;
  }
}

type ClosableEncoder = {
  close(): Promise<void>;
};

/** Serializes encoder replacement and folds a burst into one fresh process. */
export class GrpcEncoderLifecycle<T extends ClosableEncoder> {
  readonly #create: (
    restart: GrpcEncoderRestart,
  ) => T | null | Promise<T | null>;
  #current: T | null = null;
  #pending: GrpcEncoderRestart | null = null;
  #drainTask: Promise<T | null> | null = null;
  #closeTask: Promise<void> | null = null;
  #closed = false;

  constructor(
    create: (restart: GrpcEncoderRestart) => T | null | Promise<T | null>,
  ) {
    this.#create = create;
  }

  get current(): T | null {
    return this.#current;
  }

  restart(restart: GrpcEncoderRestart): Promise<T | null> {
    if (this.#closed) return Promise.resolve(null);
    this.#pending = this.#pending
      ? {
          announceSize: this.#pending.announceSize || restart.announceSize,
          clearPending: this.#pending.clearPending || restart.clearPending,
        }
      : restart;
    if (this.#drainTask) return this.#drainTask;

    const task = this.#drain();
    this.#drainTask = task;
    return task;
  }

  close(): Promise<void> {
    if (this.#closeTask) return this.#closeTask;
    this.#closed = true;
    this.#pending = null;
    this.#closeTask = (async () => {
      await this.#drainTask?.catch(() => {});
      const current = this.#current;
      this.#current = null;
      await current?.close();
    })();
    return this.#closeTask;
  }

  async #drain(): Promise<T | null> {
    let latest = this.#current;
    try {
      while (this.#pending && !this.#closed) {
        const current = this.#current;
        this.#current = null;
        await current?.close();
        if (this.#closed) break;

        // Read after shutdown so requests received while it was in progress are
        // coalesced before another ffmpeg process is spawned.
        const restart = this.#pending;
        this.#pending = null;
        const next = await this.#create(restart);
        if (!next) continue;
        if (this.#closed) {
          await next.close();
          break;
        }
        this.#current = next;
        latest = next;
      }
      return latest;
    } finally {
      // Clear the published task in the same microtask that observes an empty
      // queue. A restart arriving afterward must start a new drain instead of
      // joining a promise whose work has already completed.
      this.#drainTask = null;
    }
  }
}

const defaultReadDisplaySizeSignal: NonNullable<
  GrpcSessionDependencies["readDisplaySizeSignal"]
> = async (serial, signal) => {
  const result = await execText("adb", ["-s", serial, "shell", "wm", "size"], {
    timeout: 5_000,
    maxBuffer: MAX_DISPLAY_SIZE_OUTPUT_BYTES + 1,
    signal,
    lane: "background",
  });
  if (result.status !== 0 || result.error) {
    throw commandFailure("could not read emulator display size", result);
  }
  return parseDisplaySizeSignal(result.stdout);
};

const DEFAULT_GRPC_SESSION_RUNTIME: GrpcSessionRuntime = {
  assertFfmpeg: assertFfmpegAvailable,
  ensureEndpoint: ensureEmulatorGrpcEndpoint,
  createClient: (endpoint) => new EmulatorGrpcClient(endpoint),
  createEncoder: (options) => new H264Encoder(options),
  isDeviceAwake,
  wakeDevice: (serial, signal) => runPowerCommand(serial, "wakeup", signal),
  sleep,
};

function positiveNumber(value: number, name: string, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function nonNegativeNumber(
  value: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function nonNegativeInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  nonNegativeNumber(value, name, maximum);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Host-side emulator screenshot capture and input, encoded to the same H.264
 * packet contract as scrcpy.
 */
export async function startGrpcSession(
  options: StartEmuSessionOptions,
  dependencies: GrpcSessionDependencies = {},
): Promise<EmuSession> {
  const serial = options.serial;
  const imageMode = options.grpcImageMode;
  const inputSource: InputSource = options.inputSource;
  const openScrcpyControl =
    dependencies.startScrcpyControl ?? startScrcpyControl;
  const runtime: GrpcSessionRuntime = {
    ...DEFAULT_GRPC_SESSION_RUNTIME,
    ...dependencies.runtime,
  };
  const readDisplaySizeSignal =
    dependencies.readDisplaySizeSignal ?? defaultReadDisplaySizeSignal;
  const maxFps = positiveNumber(
    options.maxFps ?? SCRCPY_DEFAULTS.maxFps,
    "maxFps",
    1_000,
  );
  const bitRate = nonNegativeInteger(
    options.bitRate ?? SCRCPY_DEFAULTS.bitRate,
    "bitRate",
    0x7fff_ffff,
  );
  if (bitRate === 0) throw new Error("bitRate must be a positive number");
  const maxSize = nonNegativeInteger(
    options.maxSize ?? SCRCPY_DEFAULTS.maxSize,
    "maxSize",
    16_384,
  );
  const keyFrameInterval = nonNegativeNumber(
    options.keyFrameInterval ?? SCRCPY_DEFAULTS.keyFrameInterval,
    "keyFrameInterval",
  );
  const configuredRepeatFrameMs = nonNegativeNumber(
    options.repeatFrameMs ?? SCRCPY_DEFAULTS.repeatFrameMs,
    "repeatFrameMs",
    60_000,
  );
  const repeatFrameMs =
    configuredRepeatFrameMs > 0
      ? configuredRepeatFrameMs
      : DEFAULT_IDLE_REPEAT_MS;
  const frameIntervalMs = 1_000 / maxFps;
  const frameWritePacer = new GrpcFrameWritePacer(frameIntervalMs);
  const accessUnitBoundaryCadence = new GrpcAccessUnitBoundaryCadence(
    frameIntervalMs,
  );
  const captureDiagnostics = new GrpcCaptureDiagnosticsTracker(imageMode);

  if (!isEmulatorSerial(serial)) {
    throw new Error(
      `grpc-screenshot requires an Android Emulator serial; received ${serial}`,
    );
  }
  const lifetime = new AbortController();
  const abortFromParent = () =>
    lifetime.abort(
      abortReason(options.signal!, "gRPC screenshot session aborted"),
    );
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  if (options.signal?.aborted) abortFromParent();

  let endpoint: Awaited<ReturnType<typeof ensureEmulatorGrpcEndpoint>>;
  try {
    await runtime.assertFfmpeg(lifetime.signal);
    endpoint = await runtime.ensureEndpoint(serial, lifetime.signal);
  } catch (error) {
    options.signal?.removeEventListener("abort", abortFromParent);
    throw error;
  }
  const client = runtime.createClient(endpoint);
  const listeners = new Set<(failure: StreamFailure) => void>();
  const packetQueue = new GrpcVideoPacketQueue();
  const waiters: Array<(packet: VideoPacket | null) => void> = [];
  const startupGate = new H264StartupGate();
  let fatalFailure: StreamFailure | null = null;
  let closed = false;
  let closeTask: Promise<void> | null = null;
  let encoderLifecycle: GrpcEncoderLifecycle<GrpcSessionEncoder> | null = null;
  let encoderHasOutput = false;
  let captureTransport: GrpcImageCaptureTransport | null = null;
  let latest: EmuImage | null = null;
  let lastWriteAt = 0;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let displaySizePollTimer: ReturnType<typeof setTimeout> | null = null;
  let nativeTouchSize = { width: 0, height: 0 };
  let nativeTouchGeometryMonitor: GrpcNativeTouchGeometryMonitor | null = null;
  let sessionMeta: StreamMeta | null = null;
  let resolveFirstImage: ((image: EmuImage) => void) | null = null;
  let rejectFirstImage: ((error: Error) => void) | null = null;
  let requestQueuedKeyFrame: (() => void) | null = null;
  let scrcpyControl: ScrcpyControlSession | null = null;
  let removeScrcpyControlListeners: (() => void) | null = null;
  let controls: ControlInputQueue | null = null;
  const scrcpyControlStartup =
    inputSource === "scrcpy"
      ? openScrcpyControl({ serial, signal: lifetime.signal })
      : null;
  // A later gRPC startup step may fail before this promise is awaited. Keep
  // the speculative startup rejection handled while preserving it for await.
  void scrcpyControlStartup?.catch(() => {});

  const wakeReaders = () => {
    while (waiters.length) waiters.shift()!(null);
  };
  const getFatalFailure = (): StreamFailure | null => fatalFailure;
  const emitFatal = (failure: StreamFailure) => {
    if (closed || fatalFailure) return;
    fatalFailure = failure;
    const error = new Error(failure.message);
    startupGate.fail(error);
    rejectFirstImage?.(error);
    wakeReaders();
    for (const listener of listeners) listener(failure);
  };
  const pushPacket = (packet: VideoPacket) => {
    if (closed || fatalFailure) return;
    const queued = packetQueue.push(packet);
    if (queued.queued && packet.type === "frame") startupGate.observe(packet);
    if (queued.needsKeyFrame) requestQueuedKeyFrame?.();
    if (waiters.length > 0) {
      const next = packetQueue.shift();
      if (next) waiters.shift()!(next);
    }
  };
  const readFrame = (): Promise<VideoPacket | null> => {
    const packet = packetQueue.shift();
    if (packet) return Promise.resolve(packet);
    if (closed || fatalFailure) return Promise.resolve(null);
    return new Promise((resolve) => waiters.push(resolve));
  };

  const clearWriteTimers = () => {
    if (writeTimer) clearTimeout(writeTimer);
    if (flushTimer) clearTimeout(flushTimer);
    writeTimer = null;
    flushTimer = null;
  };
  const nowUs = () => BigInt(Math.round(performance.now() * 1_000));
  const writeFrame = (repeat: boolean) => {
    const encoder = encoderLifecycle?.current;
    if (
      closed ||
      lifetime.signal.aborted ||
      fatalFailure ||
      !encoder ||
      !captureTransport ||
      !latest
    ) {
      return;
    }
    const now = performance.now();
    const accepted = encoder.write(latest.image, nowUs());
    frameWritePacer.recordWrite(now, repeat, accepted);
    captureDiagnostics.recordEncoderWrite(
      repeat,
      accepted,
      latest.image.length,
      now,
    );
    if (accepted) lastWriteAt = Date.now();
    const needsFollowUp = captureTransport.needsEncoderFollowUp(
      repeat,
      encoderHasOutput,
    );
    if (repeat) {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      if (!accepted || needsFollowUp) {
        flushTimer = setTimeout(
          () => {
            flushTimer = null;
            writeFrame(true);
          },
          accepted
            ? accessUnitBoundaryCadence.boundaryDelayMs()
            : Math.min(ENCODER_WRITE_RETRY_DELAY_MS, frameIntervalMs),
        );
        flushTimer.unref?.();
      }
      return;
    }
    if (accepted && needsFollowUp) {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        flushTimer = null;
        writeFrame(true);
      }, accessUnitBoundaryCadence.boundaryDelayMs());
      flushTimer.unref?.();
    } else if (needsFollowUp && !writeTimer) {
      writeTimer = setTimeout(
        () => {
          writeTimer = null;
          scheduleWrite();
        },
        Math.min(ENCODER_WRITE_RETRY_DELAY_MS, frameIntervalMs),
      );
      writeTimer.unref?.();
    }
  };
  const scheduleWrite = () => {
    if (writeTimer || closed || !encoderLifecycle?.current || !latest) return;
    const waitMs = frameWritePacer.waitMs(performance.now());
    if (waitMs <= 0) {
      writeFrame(false);
      return;
    }
    writeTimer = setTimeout(() => {
      writeTimer = null;
      writeFrame(false);
    }, waitMs);
  };
  const currentGeometry = (image = latest) => {
    if (!image) return null;
    return resolveGrpcDisplayGeometry({
      inputWidth: image.width,
      inputHeight: image.height,
      nativeWidth: nativeTouchSize.width,
      nativeHeight: nativeTouchSize.height,
    });
  };
  encoderLifecycle = new GrpcEncoderLifecycle<GrpcSessionEncoder>((restart) => {
    if (closed || lifetime.signal.aborted || !captureTransport || !latest) {
      return null;
    }
    if (restart.clearPending) packetQueue.clear();
    const geometry = currentGeometry(latest)!;
    const size = geometry.encodedSize;
    if (size.width <= 0 || size.height <= 0) {
      emitFatal({ message: "emulator returned an image too small to encode" });
      return null;
    }
    frameWritePacer.reset(performance.now());
    encoderHasOutput = false;
    if (sessionMeta) {
      sessionMeta.width = size.width;
      sessionMeta.height = size.height;
    }
    const next = runtime.createEncoder({
      width: latest.width,
      height: latest.height,
      quarterTurn: 0,
      fps: maxFps,
      bitRate,
      keyFrameInterval,
      inputFormat: captureTransport.encoderInputFormat,
      onFrame: (frame: VideoFrame) => {
        if (!frame.isConfig) encoderHasOutput = true;
        pushPacket(frame);
      },
      onExit: (message) => emitFatal({ message, code: "encoder-exit" }),
    });
    if (restart.announceSize) {
      pushPacket({
        type: "session",
        width: size.width,
        height: size.height,
        clientResized: false,
      });
    }
    return next;
  });
  const restartEncoder = (
    announceSize: boolean,
    clearPending: boolean,
  ): Promise<void> => {
    if (closed || lifetime.signal.aborted || !latest) return Promise.resolve();
    clearWriteTimers();
    return encoderLifecycle!
      .restart({ announceSize, clearPending })
      .then((started) => {
        if (started && encoderLifecycle?.current === started) writeFrame(false);
      });
  };
  requestQueuedKeyFrame = () => {
    void restartEncoder(false, false).catch((error) =>
      emitFatal({
        message: `could not recover the H.264 packet queue: ${error instanceof Error ? error.message : String(error)}`,
        code: "encoder-exit",
      }),
    );
  };

  const refreshNativeTouchGeometry = (force = false): Promise<void> => {
    if (!nativeTouchGeometryMonitor || closed || lifetime.signal.aborted) {
      return Promise.resolve();
    }
    return nativeTouchGeometryMonitor
      .poll(lifetime.signal, force)
      .catch((error) => {
        if (!closed && !lifetime.signal.aborted) {
          console.warn(
            `serve-emu could not refresh native touch geometry: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
  };

  const scheduleDisplaySizePoll = () => {
    if (
      closed ||
      lifetime.signal.aborted ||
      displaySizePollTimer ||
      !nativeTouchGeometryMonitor
    ) {
      return;
    }
    displaySizePollTimer = setTimeout(() => {
      displaySizePollTimer = null;
      void refreshNativeTouchGeometry().finally(scheduleDisplaySizePoll);
    }, DISPLAY_SIZE_POLL_MS);
    displaySizePollTimer.unref?.();
  };

  const onImage = (
    image: EmuImage,
    source: GrpcScreenshotImageSource = "stream",
    receivedAtMs = Date.now(),
  ) => {
    if (closed) return;
    captureDiagnostics.recordUsableImage(image, receivedAtMs, Date.now());
    if (source === "stream") {
      accessUnitBoundaryCadence.recordFreshImage(performance.now());
    }
    const encoder = encoderLifecycle?.current;
    const geometryChanged =
      encoder !== null &&
      encoder !== undefined &&
      (image.width !== encoder.width || image.height !== encoder.height);
    const imageIsLandscape = image.width > image.height;
    const nativeIsLandscape = nativeTouchSize.width > nativeTouchSize.height;
    if (imageIsLandscape !== nativeIsLandscape) {
      nativeTouchSize = {
        width: nativeTouchSize.height,
        height: nativeTouchSize.width,
      };
    }
    latest = image;
    if (resolveFirstImage) {
      const resolve = resolveFirstImage;
      resolveFirstImage = null;
      resolve(image);
      return;
    }
    if (geometryChanged) {
      void refreshNativeTouchGeometry(true);
      void restartEncoder(true, true).catch((error) =>
        emitFatal({
          message: `could not restart H.264 encoder: ${error instanceof Error ? error.message : String(error)}`,
          code: "encoder-exit",
        }),
      );
      return;
    }
    scheduleWrite();
  };

  const inputState = new GrpcInputState(client);
  const touch = async (
    unitX: number,
    unitY: number,
    pressure: number,
    identifier: number,
    signal: AbortSignal,
  ) => {
    const geometry = currentGeometry();
    if (!geometry) {
      throw new ControlInputRejectedError(
        "gRPC touch input is unavailable before the first video frame",
      );
    }
    if (identifier > 0x7fffffff) {
      throw new ControlInputRejectedError(
        "gRPC touch pointerId must fit in a signed 32-bit integer",
      );
    }
    const point = geometry.mapTouch(unitX, unitY);
    await inputState.sendTouch(
      [
        {
          x: point.x,
          y: point.y,
          identifier,
          pressure,
        },
      ],
      signal,
    );
  };
  const tapTouch = async (x: number, y: number, signal: AbortSignal) => {
    await touch(x, y, TOUCH_PRESSURE, 0, signal);
    await runtime.sleep(20, signal);
    await touch(x, y, 0, 0, signal);
  };
  const swipeTouch = async (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
    signal: AbortSignal,
  ) => {
    const duration = Math.max(80, durationMs);
    const steps = Math.max(8, Math.round(duration / 16));
    await touch(x1, y1, TOUCH_PRESSURE, 0, signal);
    for (let index = 1; index < steps; index++) {
      const progress = index / steps;
      await runtime.sleep(duration / steps, signal);
      await touch(
        x1 + (x2 - x1) * progress,
        y1 + (y2 - y1) * progress,
        TOUCH_PRESSURE,
        0,
        signal,
      );
    }
    await runtime.sleep(duration / steps, signal);
    await touch(x2, y2, 0, 0, signal);
  };

  const dispatchGesture = async (
    gesture: Gesture,
    signal: AbortSignal,
  ): Promise<void> => {
    throwIfAborted(signal, "gRPC input aborted");
    switch (gesture.type) {
      case "tap":
        return tapTouch(gesture.x, gesture.y, signal);
      case "swipe":
        return swipeTouch(
          gesture.x1,
          gesture.y1,
          gesture.x2,
          gesture.y2,
          gesture.durationMs ?? 250,
          signal,
        );
      case "touch":
        return touch(
          gesture.x,
          gesture.y,
          gesture.action === "up" ? 0 : TOUCH_PRESSURE,
          gesture.pointerId ?? 0,
          signal,
        );
      case "key": {
        for (const event of androidKeyGestureToKeyboardEvents(gesture)) {
          await inputState.sendKey(event, signal);
        }
        return;
      }
      case "text":
        return inputState.sendKey(
          { text: normalizeGrpcGestureText(gesture) },
          signal,
        );
      case "back":
        return inputState.sendKey({ key: "GoBack" }, signal);
      case "home":
        return inputState.sendKey({ key: "GoHome" }, signal);
      case "recents":
        return inputState.sendKey({ key: "AppSwitch" }, signal);
      case "power":
        return inputState.sendKey({ key: "Power" }, signal);
    }
  };

  let inputReleaseTask: Promise<void> | null = null;
  const releaseInput = (): Promise<void> => {
    if (inputReleaseTask) return inputReleaseTask;
    const cleanup = new AbortController();
    const timer = setTimeout(
      () => cleanup.abort(new Error("gRPC input release timed out")),
      INPUT_RELEASE_TIMEOUT_MS,
    );
    timer.unref?.();
    let task!: Promise<void>;
    task = inputState
      .releaseAll(cleanup.signal)
      .catch((error) => {
        console.warn(
          `serve-emu could not release gRPC input state: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        clearTimeout(timer);
        if (inputReleaseTask === task) inputReleaseTask = null;
      });
    inputReleaseTask = task;
    return task;
  };

  const resetGrpcVideo = async (signal: AbortSignal) => {
    throwIfAborted(signal, "gRPC video reset aborted");
    // Existing packets remain valid until the replacement emits its IDR.
    // The lifecycle coalesces bursts and never overlaps ffmpeg shutdowns.
    await restartEncoder(false, false);
    throwIfAborted(signal, "gRPC video reset aborted");
  };

  const createGrpcControls = () =>
    new ControlInputQueue({
      dispatcher: {
        dispatchGesture: (gesture, _screen, signal) =>
          dispatchGesture(gesture, signal),
        resetVideo: resetGrpcVideo,
        close() {
          void releaseInput();
        },
      },
    });

  const createScrcpyControls = (session: ScrcpyControlSession) => {
    const writer = new SocketControlWriter(session.controlSocket);
    return new ControlInputQueue({
      dispatcher: {
        async dispatchGesture(gesture, _screen, signal) {
          // With scrcpy video disabled, touch coordinates must target the native
          // display directly rather than the downscaled gRPC encoder output.
          for (const step of compileGesture(gesture, nativeTouchSize).steps) {
            if (step.delayMs > 0) {
              await runtime.sleep(step.delayMs, signal);
            }
            await writer.write(step.packet, signal);
          }
        },
        resetVideo: resetGrpcVideo,
        close(reason) {
          writer.close(reason);
        },
      },
    });
  };

  const close = (): Promise<void> => {
    if (closeTask) return closeTask;
    let finishClose!: () => void;
    closeTask = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    closed = true;
    const transportToClose = captureTransport;
    captureTransport = null;
    transportToClose?.stop();
    options.signal?.removeEventListener("abort", abortFromParent);
    lifetime.abort(new Error("gRPC screenshot session closed"));
    clearWriteTimers();
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
    if (displaySizePollTimer) clearTimeout(displaySizePollTimer);
    displaySizePollTimer = null;
    controls?.close(new Error("gRPC screenshot session closed"));
    const inputRelease =
      inputSource === "grpc" ? releaseInput() : Promise.resolve();
    const encoderClose = encoderLifecycle?.close() ?? Promise.resolve();
    removeScrcpyControlListeners?.();
    removeScrcpyControlListeners = null;
    const scrcpyControlClose =
      scrcpyControl?.close() ??
      scrcpyControlStartup?.then(
        (session) => session.close(),
        () => {},
      ) ??
      Promise.resolve();
    scrcpyControl = null;
    listeners.clear();
    packetQueue.clear();
    wakeReaders();
    void Promise.allSettled([
      inputRelease,
      encoderClose,
      scrcpyControlClose,
    ]).then(async () => {
      client.close();
      try {
        await transportToClose?.close();
      } catch (error) {
        console.warn(
          `serve-emu could not close the gRPC screenshot transport: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      finishClose();
    });
    return closeTask;
  };
  const onParentAbort = () => {
    void close();
  };
  lifetime.signal.addEventListener("abort", onParentAbort, { once: true });
  const unsubscribeClientError = client.onSessionError((error) =>
    emitFatal({
      message: `emulator gRPC connection error: ${error.message}`,
      code: "grpc-connection-error",
    }),
  );

  try {
    throwIfAborted(lifetime.signal, "gRPC screenshot startup aborted");
    const [initialDisplaySizeSignal] = await Promise.all([
      readDisplaySizeSignal(serial, lifetime.signal).catch((error) => {
        throwIfAborted(lifetime.signal, "gRPC screenshot startup aborted");
        console.warn(
          `serve-emu could not read the initial display size: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }),
    ]);
    throwIfAborted(lifetime.signal, "gRPC screenshot startup aborted");
    if (!(await runtime.isDeviceAwake(serial, lifetime.signal))) {
      await runtime.wakeDevice(serial, lifetime.signal);
      await runtime.sleep(100, lifetime.signal);
    }
    let probe = await client.getScreenshot(
      { format: IMG_FORMAT_PNG },
      lifetime.signal,
    );
    if (probe.width <= 0 || probe.height <= 0) {
      await runtime.wakeDevice(serial, lifetime.signal);
      for (
        let attempt = 0;
        attempt < 20 && (probe.width <= 0 || probe.height <= 0);
        attempt++
      ) {
        await runtime.sleep(100, lifetime.signal);
        probe = await client.getScreenshot(
          { format: IMG_FORMAT_PNG },
          lifetime.signal,
        );
      }
      if (probe.width <= 0 || probe.height <= 0) {
        throw new Error(
          "emulator display stayed inactive after requesting wakeup",
        );
      }
    }
    nativeTouchSize = {
      width: probe.width,
      height: probe.height,
    };
    nativeTouchGeometryMonitor = new GrpcNativeTouchGeometryMonitor({
      initialDisplaySizeSignal,
      readDisplaySizeSignal: (signal) => readDisplaySizeSignal(serial, signal),
      readNativeImage: (signal) =>
        client.getScreenshot({ format: IMG_FORMAT_PNG }, signal),
      onNativeSize: (size) => {
        nativeTouchSize = size;
      },
    });
    if (inputSource === "scrcpy") {
      if (!scrcpyControlStartup) {
        throw new Error("scrcpy control startup was not initialized");
      }
      const controlSession = await scrcpyControlStartup;
      throwIfAborted(lifetime.signal, "gRPC screenshot startup aborted");
      scrcpyControl = controlSession;
      const onControlError = (error: Error) =>
        emitFatal({
          message: `scrcpy control socket error: ${error.message}`,
          code: "control-socket-error",
        });
      const onProcessExit = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (!isAbnormalExit(code, signal)) return;
        const detail = procExitDetail(code, signal);
        emitFatal({
          message: detail.reason,
          code: detail.code,
          meta: detail.meta,
        });
      };
      controlSession.controlSocket.on("error", onControlError);
      controlSession.proc.on("exit", onProcessExit);
      removeScrcpyControlListeners = () => {
        controlSession.controlSocket.off("error", onControlError);
        controlSession.proc.off("exit", onProcessExit);
      };
      controls = createScrcpyControls(controlSession);
    } else {
      controls = createGrpcControls();
    }
    const existingFailure = getFatalFailure();
    if (existingFailure) throw new Error(existingFailure.message);
    captureTransport = createGrpcImageCaptureTransport({
      imageMode,
      maxFps,
      maxSize,
      probe,
      signal: lifetime.signal,
      diagnostics: captureDiagnostics,
      consume: onImage,
      onError: (error) =>
        emitFatal({
          message: `emulator MMAP screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
          code: "grpc-stream-error",
        }),
    });
    const transport = captureTransport;

    let firstFrameTimer: ReturnType<typeof setTimeout> | null = null;
    let firstFrameAbort: (() => void) | null = null;
    const firstImage = new Promise<EmuImage>((resolve, reject) => {
      const finish = (image?: EmuImage, error?: Error) => {
        if (firstFrameTimer) clearTimeout(firstFrameTimer);
        if (firstFrameAbort) {
          lifetime.signal.removeEventListener("abort", firstFrameAbort);
        }
        resolveFirstImage = null;
        rejectFirstImage = null;
        if (error) reject(error);
        else resolve(image!);
      };
      resolveFirstImage = (image) => finish(image);
      rejectFirstImage = (error) => finish(undefined, error);
      firstFrameAbort = () =>
        finish(
          undefined,
          abortReason(lifetime.signal, "first emulator frame aborted"),
        );
      lifetime.signal.addEventListener("abort", firstFrameAbort, {
        once: true,
      });
      firstFrameTimer = setTimeout(
        () =>
          finish(
            undefined,
            new Error("timed out waiting for the first emulator frame"),
          ),
        FIRST_FRAME_TIMEOUT_MS,
      );
      firstFrameTimer.unref?.();
    });
    void client
      .streamScreenshot(
        transport.streamFormat,
        (image, source, receivedAtMs) => {
          transport.push(image, source, receivedAtMs);
        },
        lifetime.signal,
        {
          maxFps: transport.predecodeMaxFps,
          onPacingEvent: (event, detail) =>
            transport.recordRawPacingEvent(event, detail),
          onDecode: (event) => captureDiagnostics.recordImageDecode(event),
        },
      )
      .then(
        () => {
          if (!lifetime.signal.aborted) {
            emitFatal({
              message: "emulator screenshot stream ended",
              code: "grpc-stream-ended",
            });
          }
        },
        (error) => {
          if (!lifetime.signal.aborted) {
            emitFatal({
              message: `emulator screenshot stream failed: ${error instanceof Error ? error.message : String(error)}`,
              code: "grpc-stream-error",
            });
          }
        },
      );
    const first = await firstImage;
    latest = first;
    await restartEncoder(false, false);
    await startupGate.wait(lifetime.signal, FIRST_FRAME_TIMEOUT_MS);
    idleTimer = setInterval(
      () => {
        if (
          !closed &&
          encoderLifecycle?.current &&
          Date.now() - lastWriteAt >= repeatFrameMs
        ) {
          writeFrame(true);
        }
      },
      Math.max(16, Math.min(250, repeatFrameMs / 2)),
    );
    scheduleDisplaySizePoll();

    const size = currentGeometry(first)!.encodedSize;
    if (!controls) throw new Error("gRPC input controls were not initialized");
    const meta: StreamMeta = {
      deviceName: endpoint.avdName ?? serial,
      codecId: "h264",
      width: size.width,
      height: size.height,
    };
    sessionMeta = meta;
    return {
      mode: "grpc-screenshot",
      inputSource,
      serial,
      meta,
      controls,
      diagnostics: () => ({ grpcCapture: captureDiagnostics.snapshot() }),
      readFrame,
      onFatal(listener) {
        listeners.add(listener);
        if (fatalFailure) listener(fatalFailure);
        return () => listeners.delete(listener);
      },
      async close() {
        unsubscribeClientError();
        lifetime.signal.removeEventListener("abort", onParentAbort);
        await close();
      },
    };
  } catch (error) {
    unsubscribeClientError();
    lifetime.signal.removeEventListener("abort", onParentAbort);
    await close();
    throw error;
  }
}
