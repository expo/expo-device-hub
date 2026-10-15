import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readEmuConsoleValue } from "./adb.ts";
import { isEmulatorSerial } from "./device-capabilities.ts";
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

type FoldState = Omit<FoldStatus, "hingeRange">;

const UNSUPPORTED: FoldState = { supported: false, posture: null, hingeAngle: null };

/**
 * Android receives the hinge angle in eighths of a degree, and can keep the
 * previous eighth after a change of a few hundredths.
 */
const ANDROID_HINGE_STEP = 0.125;

export async function getFoldStatus(
  serial: string,
  runExec: typeof execText = execText,
): Promise<FoldStatus> {
  const state = await readFoldState(serial, runExec);
  return { ...state, hingeRange: state.supported ? await readHingeRange(serial, runExec) : null };
}

/** The sensor's angle and the posture Android derives from it. */
async function readFoldState(serial: string, runExec: typeof execText): Promise<FoldState> {
  if (!isEmulatorSerial(serial)) return UNSUPPORTED;

  const sensor = await runExec("adb", ["-s", serial, "emu", "sensor", "get", "hinge-angle0"], {
    timeout: 5_000,
    lane: "interactive",
  });
  if (sensor.status !== 0 || sensor.timedOut || sensor.error) {
    const detail = sensor.stderr.trim() || sensor.error?.message || sensor.stdout.trim() || "unknown error";
    throw new Error(`Emulator hinge sensor read failed: ${detail}`);
  }
  // Older emulators do not know the sensor; newer ones disable it on profiles without a hinge.
  if (/KO:\s*(?:unknown sensor name:\s*hinge-angle0|'hinge-angle0' sensor is disabled)/.test(sensor.stdout)) {
    return UNSUPPORTED;
  }
  const angle = Number(sensor.stdout.match(/hinge-angle0\s*=\s*(-?\d+(?:\.\d+)?)/)?.[1]);
  if (!Number.isFinite(angle)) {
    throw new Error(`Emulator hinge sensor returned an unexpected response: ${sensor.stdout.trim()}`);
  }

  const state = await runExec(
    "adb",
    ["-s", serial, "shell", "cmd", "device_state", "base-state"],
    { timeout: 5_000, lane: "interactive" },
  );
  // While an app holds an override state (rear display, dual screen), the
  // committed override comes first and the physical posture is on "Base state:".
  const name = state.status === 0
    ? (state.stdout.match(/Base state:.*?name='([A-Z_]+)'/) ?? state.stdout.match(/name='([A-Z_]+)'/))?.[1]
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
  const avdPath = await readEmuConsoleValue(serial, ["avd", "path"], runExec);
  if (!avdPath) return null;
  let config: string;
  try {
    config = await readFile(join(avdPath, "hardware-qemu.ini"), "utf8");
  } catch {
    return null;
  }
  // The value lists one range per hinge, starting with hinge-angle0's.
  const range = config.match(/^hw\.sensor\.hinge\.ranges\s*=\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/m);
  return range ? { min: Number(range[1]), max: Number(range[2]) } : null;
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
    const detail = result.stderr.trim() || result.stdout.trim() || result.error?.message || "unknown error";
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
  const current = await getFoldStatus(serial, runExec);
  if (!current.supported) throw new Error("Selected emulator does not support folding");

  // The console reads the angle back with six significant digits and uses exponent
  // notation below 0.0001, so send whole thousandths of a degree.
  const angle = Math.round(hingeAngle * 1000) / 1000;
  const range = current.hingeRange;
  if (range && (angle < range.min || angle > range.max)) {
    throw new Error(`This emulator's hinge moves only from ${range.min}° to ${range.max}°`);
  }
  const result = await runExec(
    "adb",
    ["-s", serial, "emu", "sensor", "set", "hinge-angle0", String(angle)],
    { timeout: 5_000, lane: "interactive" },
  );
  if (result.status !== 0 || result.timedOut || result.error || /\bKO:/.test(result.stdout)) {
    const detail = result.stderr.trim() || result.stdout.trim() || result.error?.message || "unknown error";
    throw new Error(`Emulator hinge angle change failed: ${detail}`);
  }

  await waitForAndroidHingeAngle(serial, angle, runExec);
  const status = await readFoldState(serial, runExec);
  if (status.hingeAngle !== angle) throw new Error(`Emulator did not confirm a ${angle}° hinge angle`);
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
  runExec: typeof execText,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const dump = await runExec("adb", ["-s", serial, "shell", "dumpsys", "device_state"], {
      timeout: 5_000,
      lane: "interactive",
    });
    if (dump.status !== 0 || dump.timedOut || dump.error) {
      const detail = dump.stderr.trim() || dump.error?.message || dump.stdout.trim() || "unknown error";
      throw new Error(`Android device state read failed: ${detail}`);
    }
    const reported = dump.stdout.match(/hinge sensor0 \(in degrees\) : \[(-?\d+(?:\.\d+)?)/)?.[1];
    // A dump without sensor values gives nothing to wait for.
    if (reported === undefined) return;
    const pending = /mPendingState=Optional\[/.test(dump.stdout);
    // @ref LLP 0004#android-emulators — measured on pixel_fold: 90.123° arrives as 90.125°
    if (Math.abs(Number(reported) - angle) < ANDROID_HINGE_STEP && !pending) return;
    if (Date.now() >= deadline) throw new Error(`Android did not report a ${angle}° hinge angle`);
    await sleep(50);
  }
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
