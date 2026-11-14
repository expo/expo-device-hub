import { createConnection, type Socket } from "node:net";
import type { DisplaySize, FoldableDisplays } from "./fold.ts";
import {
  GPU_RECORD,
  GPU_ROLE_PROTOCOL,
  GpuPacketReader,
  gpuCanvasCommand,
  gpuRoleCommand,
  gpuSettingsCommand,
  parseGpuDetails,
  splitGpuAccessUnit,
  type GpuRecord,
} from "./gpu-packet.ts";
import { GpuCaptureEncoderError, GpuCaptureUnavailableError } from "./gpu-session.ts";
import {
  screenForImage,
  type RecordingGeometry,
  type RecordingRect,
  type RecordingScreen,
} from "./recording-canvas.ts";
import type { RecordingEncodingRequest, ScreenRecording } from "./screen-recording.ts";

/** The recording's own encode settings, after the defaults. */
export type CaptureRecordingEncoding = {
  /** The canvas's longest edge; 0 keeps the native size. */
  maxSize: number;
  fps: number;
  bitRate: number;
};

export type CaptureRecordingSourceOptions = {
  serial: string;
  socketPath: string;
  recorder: ScreenRecording;
  encoding: CaptureRecordingEncoding;
  /** A foldable's two displays, for a canvas that fits both; null for one display. */
  displays: FoldableDisplays | null;
  /** False once adb no longer lists the device online. Asked when the agent closes the socket. */
  deviceOnline(): Promise<boolean>;
  /** A frame shows another display than the frame before: the device folded or unfolded. */
  onScreenChange?(): void;
  connect?: (path: string) => Socket;
  /** How long the agent has to answer a connection with hello. */
  helloTimeoutMs?: number;
  log?: (message: string) => void;
};

export type CaptureRecordingSource = {
  /** The size of every recorded frame. */
  readonly canvas: DisplaySize;
  /** Closes the agent connection; the recording itself is the caller's to finish. */
  close(): void;
};

// @ref LLP 0023#requirements — native size, the display's refresh rate and 8 Mbit/s by default
export const DEFAULT_RECORDING_BIT_RATE = 8_000_000;
export const DEFAULT_RECORDING_FPS = 60;
/** The agent's highest frame rate. */
const MAX_RECORDING_FPS = 120;

/** `hw.lcd.vsync` from the emulator's hardware config, capped at 120; null when absent. */
export function displayRefreshRate(config: string | null): number | null {
  const value = config?.match(/^hw\.lcd\.vsync\s*=\s*(\d+)\s*$/m)?.[1];
  if (value === undefined) return null;
  const rate = Number(value);
  return Number.isSafeInteger(rate) && rate >= 1 ? Math.min(rate, MAX_RECORDING_FPS) : null;
}

/** The recording's encode settings: the request, else native size, the display's rate, 8 Mbit/s. */
export function captureRecordingEncoding(
  request: RecordingEncodingRequest | undefined,
  config: string | null,
): CaptureRecordingEncoding {
  return {
    maxSize: request?.maxSize ?? 0,
    fps: request?.fps ?? displayRefreshRate(config) ?? DEFAULT_RECORDING_FPS,
    bitRate: request?.bitRate ?? DEFAULT_RECORDING_BIT_RATE,
  };
}

const HELLO_TIMEOUT_MS = 5_000;
/** How often the source checks that its recording still runs, for a still screen. */
const ACTIVE_CHECK_MS = 1_000;
/** More reconnects than this within the window fail the recording. */
const MAX_RECONNECTS = 3;
const RECONNECT_WINDOW_MS = 60_000;

/**
 * The agent is gone: nothing answers its socket, or a new agent answers it. The agent runs
 * inside the emulator's process, so the emulator is gone too.
 */
class CaptureAgentGoneError extends GpuCaptureUnavailableError {}

type Geometry = { fromPts: bigint; geometry: RecordingGeometry };

function contentRectFrom(value: unknown, canvas: DisplaySize): RecordingRect | null {
  if (!value || typeof value !== "object") return null;
  const rect = value as Record<string, unknown>;
  const [x, y, width, height] = [rect.x, rect.y, rect.width, rect.height];
  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height)
  )
    return null;
  const r = { x, y, width, height } as RecordingRect;
  return r.x >= 0 &&
    r.y >= 0 &&
    r.width > 0 &&
    r.height > 0 &&
    r.x + r.width <= canvas.width &&
    r.y + r.height <= canvas.height
    ? r
    : null;
}

/**
 * A display capped at `maxSize` on its longest edge (0 keeps it), with even edges, in the
 * integer steps of the agent's `streamSize` (protocol.h), so the canvas matches the stream.
 */
function cappedSize(display: DisplaySize, maxSize: number): DisplaySize {
  const edge = Math.max(display.width, display.height);
  const target = Math.min(maxSize > 0 ? Math.min(maxSize, edge) : edge, 4096);
  const scaled = (value: number) =>
    Math.max(2, Math.floor(Math.floor((value * target) / edge) / 2) * 2);
  return { width: scaled(display.width), height: scaled(display.height) };
}

/**
 * The recording's canvas: for a foldable, the bounding box of both displays, as LLP 0018's fold
 * canvas; otherwise the native display. Each display is capped at `maxSize` first.
 */
export function captureRecordingCanvas(
  native: DisplaySize,
  displays: FoldableDisplays | null,
  maxSize: number,
): DisplaySize {
  if (!displays) return cappedSize(native, maxSize);
  const inner = cappedSize(displays.inner, maxSize);
  const outer = cappedSize(displays.outer, maxSize);
  return {
    width: Math.max(inner.width, outer.width),
    height: Math.max(inner.height, outer.height),
  };
}

// @ref LLP 0023#recording-source-in-serve-emu — the recording's own consumer of the capture agent
/**
 * Connects to the emulator capture agent as its recording consumer and feeds `recorder` until it
 * ends. The agent encodes the recording apart from the live stream, in the panel orientation, on
 * a fixed canvas, so stream changes, source switches, rotations and folds do not reach it.
 *
 * Resolves once the agent accepted the recording role. Rejects with `GpuCaptureUnavailableError`
 * when the agent does not answer or is too old to have the recording role, and with
 * `GpuCaptureEncoderError` when it cannot encode on this host.
 *
 * When the agent closes the connection, the source asks adb and connects again. A device that is
 * gone, or an agent that no longer answers, ends the device: the recording finishes at once with
 * `stopReason: "device-ended"`.
 */
export async function startCaptureRecordingSource(
  options: CaptureRecordingSourceOptions,
): Promise<CaptureRecordingSource> {
  const { recorder, serial, displays } = options;
  const log = options.log ?? ((message: string) => console.warn(message));
  const connect = options.connect ?? createConnection;
  let canvas: DisplaySize | null = null;
  // Host monotonic time minus the agent's clock: both are monotonic clocks of this host.
  let offsetUs: bigint | null = null;
  let lastPts = -1n;
  let native: DisplaySize = { width: 0, height: 0 };
  let geometries: Geometry[] = [];
  let lastScreen: RecordingScreen | undefined;
  let config: Buffer | null = null;
  let sps: Buffer | null = null;
  let pps: Buffer | null = null;
  let announced = false;
  let closed = false;
  let current: Socket | null = null;
  const reconnects: number[] = [];

  // A still screen sends no frames, so a recording that the duration limit finished is seen here.
  const activeCheck = setInterval(() => {
    if (!recorder.active) close();
  }, ACTIVE_CHECK_MS);
  activeCheck.unref?.();
  const close = () => {
    closed = true;
    clearInterval(activeCheck);
    current?.destroy();
    current = null;
  };

  const ended = (reason: string) => {
    if (closed) return;
    close();
    if (!recorder.active) return;
    log(`[emulator capture] ${serial}: the device ended (${reason}); finishing the recording`);
    void recorder.endWithDevice().catch(() => {});
  };

  const geometryAt = (pts: bigint): RecordingGeometry | undefined => {
    let index = 0;
    for (let i = geometries.length - 1; i >= 0; i--) {
      if (geometries[i]!.fromPts <= pts) {
        index = i;
        break;
      }
    }
    // Later frames are not older, so earlier geometries are no longer needed.
    if (index > 0) geometries = geometries.slice(index);
    return geometries[0]?.geometry;
  };

  const onRecord = (record: GpuRecord, socket: Socket) => {
    if (!canvas || offsetUs === null) throw new Error("Capture recording arrived before hello");
    if (record.flags === GPU_RECORD.replaced) {
      close();
      recorder.fail(new Error("Another program took over the emulator capture's recording."));
      return;
    }
    if (record.flags === GPU_RECORD.resized) {
      native = { width: record.width, height: record.height };
      return;
    }
    if (record.width !== canvas.width || record.height !== canvas.height)
      throw new Error("The capture agent changed the recording canvas");
    if (record.flags === GPU_RECORD.configured) {
      const details = parseGpuDetails(record.data);
      const contentRect = contentRectFrom(details.contentRect, canvas);
      const fromPts = details.fromPts;
      if (details.role !== "recording" || !contentRect || !Number.isSafeInteger(fromPts))
        throw new Error("The capture agent did not configure a recording");
      geometries.push({
        fromPts: BigInt(fromPts as number),
        geometry: {
          width: native.width,
          height: native.height,
          ...(displays ? { screen: screenForImage(native, displays) } : {}),
          contentRect,
        },
      });
      if (!announced) {
        announced = true;
        log(
          `[emulator capture] ${serial}: recording ${canvas.width}x${canvas.height}@${record.fps} on its own encode (${String(details.framePath)} frames, ${String(details.encoder)})`,
        );
      }
      return;
    }
    if (record.flags !== GPU_RECORD.frame && record.flags !== GPU_RECORD.keyFrame) return;
    if (record.pts <= lastPts) throw new Error("Capture recording timestamp did not increase");
    lastPts = record.pts;
    const geometry = geometryAt(record.pts);
    if (
      geometry?.screen !== undefined &&
      lastScreen !== undefined &&
      geometry.screen !== lastScreen
    )
      options.onScreenChange?.();
    lastScreen = geometry?.screen;
    const pts = record.pts + offsetUs;
    const unit = splitGpuAccessUnit(record.data);
    sps = unit.sps ?? sps;
    pps = unit.pps ?? pps;
    if (sps && pps) {
      const next = Buffer.concat([sps, pps]);
      if (!config?.equals(next)) {
        config = next;
        recorder.accept(
          { type: "frame", data: next, pts, isConfig: true, isKey: false },
          canvas,
          "capture-recording",
        );
      }
    }
    if (unit.data.length) {
      recorder.accept(
        { type: "frame", data: unit.data, pts, isConfig: false, isKey: unit.isIdr },
        canvas,
        "capture-recording",
        geometry,
      );
    }
    // The recording finished or failed: the agent can stop its encode.
    if (!recorder.active && current === socket) close();
  };

  /** Connects as the recording consumer; resolves once the agent has the role's settings. */
  const open = () =>
    new Promise<void>((resolve, reject) => {
      const socket = connect(options.socketPath);
      let started = false;
      let received = 0;
      const timer = setTimeout(
        () => fail(new GpuCaptureUnavailableError("The emulator capture agent did not answer")),
        options.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
      );
      timer.unref?.();
      const fail = (error: unknown) => {
        clearTimeout(timer);
        socket.destroy();
        if (!started) {
          const cause = error instanceof Error ? error : new Error(String(error));
          // Nothing answered: the socket is left from an emulator that exited, or it is gone.
          reject(
            cause instanceof GpuCaptureUnavailableError
              ? cause
              : received === 0
                ? new CaptureAgentGoneError(cause.message, { cause })
                : cause,
          );
          return;
        }
        if (current !== socket || closed) return;
        current = null;
        void lost(error instanceof Error ? error.message : String(error));
      };
      const reader = new GpuPacketReader((record) => {
        if (started) {
          onRecord(record, socket);
          return;
        }
        if (record.flags !== GPU_RECORD.hello)
          throw new Error("The capture agent did not start with a handshake");
        const details = parseGpuDetails(record.data);
        if (typeof details.encoderError === "string" && details.encoderError)
          throw new GpuCaptureEncoderError(details.encoderError);
        if (typeof details.protocol !== "number" || details.protocol < GPU_ROLE_PROTOCOL)
          throw new GpuCaptureUnavailableError(
            "The emulator capture agent has no recording role; start the emulator with a newer agent",
          );
        if (!Number.isSafeInteger(details.clockUs))
          throw new Error("The capture agent's hello has no clock");
        const clockUs = BigInt(details.clockUs as number);
        // The agent's clock starts with the emulator, so a smaller clock is a new emulator.
        if (clockUs <= lastPts)
          throw new CaptureAgentGoneError("The emulator started again with a new capture agent");
        native = { width: record.width, height: record.height };
        if (!canvas) {
          canvas = captureRecordingCanvas(native, displays, options.encoding.maxSize);
          offsetUs = recorder.monotonicUs() - clockUs;
          if (displays) {
            // The fold canvas gives the timeline the closed posture's angles, and an older
            // client that knows only `followsFold` keeps fold commands free.
            recorder.foldCanvas({ canvas, displays, maxSize: options.encoding.maxSize });
            recorder.followFold();
          }
        }
        socket.write(gpuRoleCommand("recording"));
        socket.write(gpuCanvasCommand(canvas.width, canvas.height));
        // The canvas sets the size, so the longest-edge cap has nothing more to do.
        socket.write(gpuSettingsCommand(0, options.encoding.fps, options.encoding.bitRate));
        started = true;
        clearTimeout(timer);
        current = socket;
        resolve();
      });
      socket.on("data", (chunk) => {
        received += chunk.length;
        try {
          reader.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        } catch (error) {
          if (started && current === socket) recorder.fail(error);
          fail(error);
        }
      });
      socket.on("error", fail);
      socket.on("close", () => fail(new Error("The emulator capture agent closed the recording")));
    });

  /** The agent closed the connection: the device ended, or the agent dropped this consumer. */
  const lost = async (reason: string) => {
    if (closed || !recorder.active) return close();
    const now = Date.now();
    while (reconnects.length && now - reconnects[0]! > RECONNECT_WINDOW_MS) reconnects.shift();
    if (!(await options.deviceOnline().catch(() => true))) return ended("adb lists it no more");
    if (closed || !recorder.active) return close();
    if (reconnects.length >= MAX_RECONNECTS) {
      close();
      recorder.fail(new Error(`The emulator capture agent keeps closing the recording: ${reason}`));
      return;
    }
    reconnects.push(now);
    log(
      `[emulator capture] ${serial}: the recording connection closed (${reason}); connecting again`,
    );
    try {
      await open();
      // Another consumer of the recording role, or a stop, may have come meanwhile.
      if (closed || !recorder.active) close();
    } catch (error) {
      if (error instanceof CaptureAgentGoneError) return ended(error.message);
      close();
      recorder.fail(error);
    }
  };

  try {
    await open();
  } catch (error) {
    close();
    throw error;
  }
  return {
    get canvas() {
      return canvas!;
    },
    close,
  };
}
