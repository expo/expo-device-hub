import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readEmuConsoleValue } from "./adb.ts";
import { isEmulatorSerial } from "./device-capabilities.ts";
import {
  EmulatorGrpcClient,
  ensureEmulatorGrpcEndpoint,
  PHYSICAL_MODEL_HINGE_ANGLE0,
} from "./emulator-grpc.ts";
import { execText } from "./exec.ts";
import type { FoldPosture, FoldRequest, FoldStatus } from "./shared/api-contracts.ts";

const POSTURES: Record<string, FoldPosture> = {
  CLOSED: "closed",
  HALF_OPENED: "half_opened",
  OPENED: "opened",
  REAR_DISPLAY_MODE: "flipped",
  FLIPPED: "flipped",
  TENT: "tent",
};

/** The hinge state of a device, without its range. */
export type FoldState = Omit<FoldStatus, "hingeRange">;

const UNSUPPORTED: FoldState = { supported: false, posture: null, hingeAngle: null };

/**
 * Android receives the hinge angle in eighths of a degree, and can keep the
 * previous eighth after a change of a few hundredths.
 */
const ANDROID_HINGE_STEP = 0.125;
const HINGE_READBACK_TIMEOUT_MS = 2_000;

export async function getFoldStatus(
  serial: string,
  runExec: typeof execText = execText,
): Promise<FoldStatus> {
  const state = await readFoldState(serial, runExec);
  return { ...state, hingeRange: state.supported ? await readHingeRange(serial, runExec) : null };
}

/** The sensor's angle and the posture Android derives from it. */
export async function readFoldState(
  serial: string,
  runExec: typeof execText = execText,
): Promise<FoldState> {
  if (!isEmulatorSerial(serial)) return UNSUPPORTED;

  const sensor = await runExec("adb", ["-s", serial, "emu", "sensor", "get", "hinge-angle0"], {
    timeout: 5_000,
    lane: "interactive",
  });
  if (sensor.status !== 0 || sensor.timedOut || sensor.error) {
    const detail =
      sensor.stderr.trim() || sensor.error?.message || sensor.stdout.trim() || "unknown error";
    throw new Error(`Emulator hinge sensor read failed: ${detail}`);
  }
  // Older emulators do not know the sensor; newer ones disable it on profiles without a hinge.
  if (
    /KO:\s*(?:unknown sensor name:\s*hinge-angle0|'hinge-angle0' sensor is disabled)/.test(
      sensor.stdout,
    )
  ) {
    return UNSUPPORTED;
  }
  const angle = Number(
    sensor.stdout.match(/hinge-angle0\s*=\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[1],
  );
  if (!Number.isFinite(angle)) {
    throw new Error(
      `Emulator hinge sensor returned an unexpected response: ${sensor.stdout.trim()}`,
    );
  }

  const state = await runExec("adb", ["-s", serial, "shell", "cmd", "device_state", "base-state"], {
    timeout: 5_000,
    lane: "interactive",
  });
  // While an app holds an override state (rear display, dual screen), the
  // committed override comes first and the physical posture is on "Base state:".
  const name =
    state.status === 0
      ? (state.stdout.match(/Base state:.*?name='([A-Z_]+)'/) ??
          state.stdout.match(/name='([A-Z_]+)'/))?.[1]
      : undefined;
  const posture = name ? POSTURES[name] : undefined;
  return {
    supported: true,
    posture: posture ?? (angle <= 5 ? "closed" : angle >= 175 ? "opened" : null),
    hingeAngle: angle,
  };
}

/**
 * The angles hinge-angle0 moves through, from `hw.sensor.hinge.ranges` in the
 * hardware config the emulator writes at launch: 0–180° on pixel_fold, but
 * 180–360° on the SDK's 8" Fold-out. Null when that file cannot be read here,
 * for example when adb reaches an emulator on another host.
 */
async function readHingeRange(
  serial: string,
  runExec: typeof execText,
): Promise<FoldStatus["hingeRange"]> {
  const config = await readHardwareConfig(serial, runExec);
  if (config === null) return null;
  // The value lists one range per hinge, starting with hinge-angle0's.
  const range = config.match(
    /^hw\.sensor\.hinge\.ranges\s*=\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/m,
  );
  if (!range) return null;
  const min = Number(range[1]);
  const max = Number(range[2]);
  return Number.isFinite(min) && Number.isFinite(max) && min < max ? { min, max } : null;
}

/**
 * The hardware config that the emulator writes at launch, or null when this
 * host cannot read it, for example when adb reaches an emulator on another host.
 */
async function readHardwareConfig(
  serial: string,
  runExec: typeof execText,
): Promise<string | null> {
  const avdPath = await readEmuConsoleValue(serial, ["avd", "path"], runExec);
  if (!avdPath) return null;
  try {
    return await readFile(join(avdPath, "hardware-qemu.ini"), "utf8");
  } catch {
    return null;
  }
}

/** A display's size in its native pixels. */
export type DisplaySize = { width: number; height: number };

/** Hinge angles in degrees, from `min` to `max`. */
export type HingeAngles = { min: number; max: number };

/**
 * The two displays of a foldable emulator: `inner` is the whole panel that the
 * open device shows, and `outer` is the display region that the closed device
 * shows, such as a Pixel Pro Fold's cover display. `closedHinge` is the closed
 * posture's angles, at which the emulator shows `outer`, when its profile names them.
 */
export type FoldableDisplays = {
  inner: DisplaySize;
  outer: DisplaySize;
  closedHinge?: HingeAngles;
};

/** The displays of a foldable emulator, or null for a device without a hinge and a fold region. */
export async function readFoldableDisplays(
  serial: string,
  runExec: typeof execText = execText,
): Promise<FoldableDisplays | null> {
  if (!isEmulatorSerial(serial)) return null;
  const config = await readHardwareConfig(serial, runExec);
  return config === null ? null : parseFoldableDisplays(config);
}

export function parseFoldableDisplays(config: string): FoldableDisplays | null {
  const value = (key: string) =>
    config.match(new RegExp(`^${key.replace(/\./g, "\\.")}\\s*=\\s*(.*?)\\s*$`, "m"))?.[1];
  const size = (prefix: string): DisplaySize | null => {
    const width = Number(value(`${prefix}.width`));
    const height = Number(value(`${prefix}.height`));
    return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
      ? { width, height }
      : null;
  };
  if (!/^(?:true|yes)$/i.test(value("hw.sensor.hinge") ?? "")) return null;
  // @ref LLP 0018#fold-canvas — only a device that shows region 0.1 while closed, as the Pixel folds do
  // Posture 1 is the emulator's closed posture. A fold-out profile shows its region at another one.
  if (value("hw.sensor.hinge.fold_to_displayRegion.0.1_at_posture") !== "1") return null;
  const inner = size("hw.lcd");
  // The emulator shows display region 0.1 of the panel while the device is folded.
  const outer = size("hw.displayRegion.0.1");
  if (!inner || !outer) return null;
  const closedHinge = postureAngles(
    value("hw.sensor.posture_list"),
    value("hw.sensor.hinge_angles_posture_definitions"),
    "1",
  );
  return closedHinge ? { inner, outer, closedHinge } : { inner, outer };
}

/**
 * One posture's hinge angles from the profile's lists, such as `1, 2, 3` and
 * `0-30, 30-150, 150-180`, where each range belongs to the posture at its index.
 */
function postureAngles(
  postures: string | undefined,
  definitions: string | undefined,
  posture: string,
): HingeAngles | null {
  const index =
    postures
      ?.split(",")
      .map((entry) => entry.trim())
      .indexOf(posture) ?? -1;
  if (index < 0) return null;
  const range = definitions
    ?.split(",")
    [index]?.trim()
    .match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (!range) return null;
  const min = Number(range[1]);
  const max = Number(range[2]);
  return min < max ? { min, max } : null;
}

/** A foldable emulator's hinge, read over its gRPC controller instead of two adb commands. */
export type HingeSensor = {
  /** The angle in degrees, or null when the emulator has no hinge. */
  readAngle(signal?: AbortSignal): Promise<number | null>;
  /**
   * Calls `onChange` when the emulator pushes a posture change, until `signal` aborts. The
   * emulator pushes no angle, so the caller reads it then.
   */
  watchPostures(onChange: () => void, signal: AbortSignal): Promise<void>;
  close(): void;
};

/** A hinge read waits this long, so a stuck read does not hold the next one for long. */
const HINGE_SENSOR_TIMEOUT_MS = 1_000;

export async function openHingeSensor(serial: string, signal?: AbortSignal): Promise<HingeSensor> {
  const client = new EmulatorGrpcClient(await ensureEmulatorGrpcEndpoint(serial, signal), {
    unaryTimeoutMs: HINGE_SENSOR_TIMEOUT_MS,
  });
  return {
    readAngle: async (readSignal) =>
      (await client.getPhysicalModel(PHYSICAL_MODEL_HINGE_ANGLE0, readSignal))?.[0] ?? null,
    watchPostures: (onChange, watchSignal) => client.streamPostures(() => onChange(), watchSignal),
    close: () => client.close(),
  };
}

export async function setFoldPosture(
  serial: string,
  posture: "closed" | "opened",
  runExec: typeof execText = execText,
): Promise<FoldStatus> {
  const current = await getFoldStatus(serial, runExec);
  if (!current.supported) throw new Error("Selected emulator does not support folding");

  const command = posture === "closed" ? "fold" : "unfold";
  const result = await runExec("adb", ["-s", serial, "emu", command], {
    timeout: 5_000,
    lane: "interactive",
  });
  if (result.status !== 0 || result.timedOut || result.error || /\bKO:/.test(result.stdout)) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || result.error?.message || "unknown error";
    throw new Error(`Emulator ${command} failed: ${detail}`);
  }

  const deadline = Date.now() + 2_000;
  let status = await readFoldState(serial, runExec);
  while (status.posture !== posture && Date.now() < deadline) {
    await sleep(50);
    status = await readFoldState(serial, runExec);
  }
  if (status.posture !== posture) throw new Error(`Emulator did not confirm ${posture} posture`);
  return { ...status, hingeRange: current.hingeRange };
}

export async function setHingeAngle(
  serial: string,
  hingeAngle: number,
  runExec: typeof execText = execText,
): Promise<FoldStatus> {
  if (!Number.isFinite(hingeAngle) || hingeAngle < 0 || hingeAngle > 180) {
    throw new Error("hingeAngle must be a number between 0 and 180");
  }
  const current = await getFoldStatus(serial, runExec);
  if (!current.supported) throw new Error("Selected emulator does not support folding");

  // The console reads the angle back with six significant digits and uses exponent
  // notation below 0.0001, so send whole thousandths of a degree.
  const angle = Math.round(hingeAngle * 1000) / 1000;
  const range = current.hingeRange;
  if (!range) throw new Error("Cannot determine this emulator's hinge range");
  if (angle < range.min || angle > range.max) {
    throw new Error(`This emulator's hinge moves only from ${range.min}° to ${range.max}°`);
  }
  // A tolerated guest sample can still be the sample from before this write.
  const previousGuestAngle =
    angle !== current.hingeAngle ? (await readAndroidHingeSample(serial, runExec)).angle : null;
  const result = await runExec(
    "adb",
    ["-s", serial, "emu", "sensor", "set", "hinge-angle0", String(angle)],
    { timeout: 5_000, lane: "interactive" },
  );
  if (result.status !== 0 || result.timedOut || result.error || /\bKO:/.test(result.stdout)) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || result.error?.message || "unknown error";
    throw new Error(`Emulator hinge angle change failed: ${detail}`);
  }

  await waitForAndroidHingeAngle(serial, angle, previousGuestAngle, runExec);
  const status = await readFoldState(serial, runExec);
  if (status.hingeAngle !== angle)
    throw new Error(`Emulator did not confirm a ${angle}° hinge angle`);
  return { ...status, hingeRange: range };
}

/**
 * The console stores a new angle at once, but Android sees it only when the
 * guest's sensor HAL next delivers it, and derives the posture then. Until
 * device_state reports the angle, it still reports the previous posture.
 */
async function waitForAndroidHingeAngle(
  serial: string,
  angle: number,
  previousGuestAngle: number | null,
  runExec: typeof execText,
): Promise<void> {
  const deadline = Date.now() + HINGE_READBACK_TIMEOUT_MS;
  for (;;) {
    const sample = await readAndroidHingeSample(serial, runExec);
    // An older guest without sensor values gives nothing to wait for.
    if (sample.angle === null) return;
    const expired = Date.now() >= deadline;
    // @ref LLP 0004#android-emulators — tolerate quantization, but let an unchanged prior sample settle
    const matches = Math.abs(sample.angle - angle) < ANDROID_HINGE_STEP && !sample.pending;
    const ambiguous = sample.angle === previousGuestAngle && sample.angle !== angle;
    if (matches && (!ambiguous || expired)) return;
    if (expired) throw new Error(`Android did not report a ${angle}° hinge angle`);
    await sleep(50);
  }
}

async function readAndroidHingeSample(
  serial: string,
  runExec: typeof execText,
): Promise<{ angle: number | null; pending: boolean }> {
  const dump = await runExec("adb", ["-s", serial, "shell", "dumpsys", "device_state"], {
    timeout: 5_000,
    lane: "interactive",
  });
  if (dump.status !== 0 || dump.timedOut || dump.error) {
    const detail =
      dump.stderr.trim() || dump.error?.message || dump.stdout.trim() || "unknown error";
    throw new Error(`Android device state read failed: ${detail}`);
  }
  const reported = dump.stdout.match(
    /hinge sensor0 \(in degrees\) : \[(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/,
  )?.[1];
  return {
    angle: reported === undefined ? null : Number(reported),
    pending: /mPendingState=Optional\[/.test(dump.stdout),
  };
}

export function applyFoldRequest(
  serial: string,
  request: FoldRequest,
  runExec: typeof execText = execText,
): Promise<FoldStatus> {
  return "posture" in request
    ? setFoldPosture(serial, request.posture, runExec)
    : setHingeAngle(serial, request.hingeAngle, runExec);
}
