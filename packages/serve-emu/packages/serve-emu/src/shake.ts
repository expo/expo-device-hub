import { setTimeout as sleep } from "node:timers/promises";
import { isEmulatorSerial } from "./device-capabilities.ts";
import { execText, type ExecResult } from "./exec.ts";

/**
 * Android has no system shake event: apps detect a shake from the accelerometer. A shake is a
 * short burst of strong, alternating acceleration on the x axis, written through the emulator
 * console.
 *
 * The burst is short on purpose. The Android shake detectors of Expo Go and expo-dev-menu
 * toggle the dev menu after 3 sign changes above 1.33 g, then ignore samples for 600 ms, so a
 * longer burst toggles the menu again. React Native's own detector (bridgeless, minNumShakes 2)
 * needs 16 sign changes, so a bare React Native app without expo-dev-menu does not react to it.
 * Sources: react-native 0.80 `common/ShakeDetector.kt` and `runtime/ReactHostImpl.java`, expo
 * `expo-dev-menu/.../detectors/ShakeDetector.kt` and `expo-go/.../utils/ShakeDetector.kt`.
 */
/** About 2 g, in m/s². The detectors need more than 1.33 g (13.04 m/s²) on one axis. */
export const SHAKE_ACCELERATION = 19.6;
/** Writes in the burst: + − + − +, so the x axis changes sign 4 times after the first count. */
export const SHAKE_WRITES = 5;
/** The time each burst value stays, so that a 15 Hz (SENSOR_DELAY_UI) listener reads it. */
export const SHAKE_INTERVAL_MS = 100;
export const SHAKE_EMULATOR_ONLY_MESSAGE = "Shake is available only on Android Emulator devices";

const SHAKE_COMMAND_TIMEOUT_MS = 5_000;
const NUMBER = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const ACCELERATION = new RegExp(
  String.raw`acceleration\s*=\s*(${NUMBER}):(${NUMBER}):(${NUMBER})(?=\s|$)`,
);

/** The device is not an emulator, so the console cannot set its accelerometer. */
export class ShakeUnsupportedError extends Error {
  constructor() {
    super(SHAKE_EMULATOR_ONLY_MESSAGE);
    this.name = "ShakeUnsupportedError";
  }
}

/** The resting value as the console printed it, so the restore writes the same tokens. */
type Acceleration = [x: string, y: string, z: string];

type RunningShake = { done: Promise<void>; stop(): void };

const running = new Map<string, RunningShake>();

/**
 * Shake an emulator: read the resting acceleration, write the burst, then write the resting
 * value back, also after a failed write. A request that arrives while a shake runs on the same
 * device gets that shake's promise, so the read never sees a shaken value.
 */
export function shakeEmulator(
  serial: string,
  runExec: typeof execText = execText,
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<void> {
  if (!isEmulatorSerial(serial)) return Promise.reject(new ShakeUnsupportedError());
  const current = running.get(serial);
  if (current) return current.done;
  let stopped = false;
  const done = runShake(serial, runExec, wait, () => stopped).finally(() => {
    if (running.get(serial)?.done === done) running.delete(serial);
  });
  running.set(serial, {
    done,
    stop: () => {
      stopped = true;
    },
  });
  return done;
}

/**
 * Stop the bursts that run on `serials`, or on every device, after their current write, and wait
 * until each one has written its resting value back. A server calls this before it stops, so an
 * emulator does not keep a shaken acceleration when the process exits during a burst. It never
 * rejects; a failed restore stays the shake's own error.
 */
export async function settleShakes(serials?: Iterable<string>): Promise<void> {
  const shakes = serials
    ? [...serials].flatMap((serial) => running.get(serial) ?? [])
    : [...running.values()];
  for (const shake of shakes) shake.stop();
  await Promise.allSettled(shakes.map((shake) => shake.done));
}

async function runShake(
  serial: string,
  runExec: typeof execText,
  wait: (ms: number) => Promise<unknown>,
  stopped: () => boolean,
): Promise<void> {
  const [restX, restY, restZ] = await readAcceleration(serial, runExec);
  let burstError: unknown = null;
  try {
    for (let index = 0; index < SHAKE_WRITES && !stopped(); index++) {
      const x = index % 2 === 0 ? SHAKE_ACCELERATION : -SHAKE_ACCELERATION;
      await writeAcceleration(serial, [String(x), restY, restZ], runExec);
      await wait(SHAKE_INTERVAL_MS);
    }
  } catch (error) {
    burstError = error;
  }
  try {
    await writeAcceleration(serial, [restX, restY, restZ], runExec);
  } catch (restoreError) {
    const restore = `Emulator acceleration restore failed: ${message(restoreError)}`;
    throw new Error(burstError ? `${message(burstError)}; ${restore}` : restore);
  }
  if (burstError) throw burstError;
}

async function readAcceleration(serial: string, runExec: typeof execText): Promise<Acceleration> {
  const result = await runConsole(serial, ["sensor", "get", "acceleration"], runExec);
  if (failed(result)) {
    throw new Error(`Emulator acceleration read failed: ${detail(result)}`);
  }
  const match = result.stdout.match(ACCELERATION);
  if (!match) {
    throw new Error(
      `Emulator returned an unexpected acceleration response: ${result.stdout.trim()}`,
    );
  }
  return [match[1]!, match[2]!, match[3]!];
}

async function writeAcceleration(
  serial: string,
  value: Acceleration,
  runExec: typeof execText,
): Promise<void> {
  const result = await runConsole(
    serial,
    ["sensor", "set", "acceleration", value.join(":")],
    runExec,
  );
  if (failed(result)) {
    throw new Error(`Emulator acceleration write failed: ${detail(result)}`);
  }
}

function runConsole(
  serial: string,
  args: string[],
  runExec: typeof execText,
): Promise<ExecResult<string>> {
  return runExec("adb", ["-s", serial, "emu", ...args], {
    timeout: SHAKE_COMMAND_TIMEOUT_MS,
    lane: "interactive",
  });
}

function failed(result: ExecResult<string>): boolean {
  return result.status !== 0 || result.timedOut || !!result.error || /\bKO:/.test(result.stdout);
}

function detail(result: ExecResult<string>): string {
  return result.stderr.trim() || result.stdout.trim() || result.error?.message || "unknown error";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
