import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run `adb devices -l` and return its stdout, or `null` on failure.
 * Never throws.
 */
export async function runAdbDevices(adbPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(adbPath, ["devices", "-l"]);
    return stdout;
  } catch (error) {
    console.error("[android-utils] Failed to run `adb devices -l`:", error);
    return null;
  }
}

/**
 * Run `adb -s <serial> shell getprop` and return its stdout, or `null` on
 * failure. Never throws.
 */
export async function runAdbGetprop(adbPath: string, serial: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(adbPath, ["-s", serial, "shell", "getprop"]);
    return stdout;
  } catch (error) {
    console.error(`[android-utils] Failed to read getprop for ${serial}:`, error);
    return null;
  }
}

/**
 * Run `adb -s <serial> emu avd name` and return its stdout, or `null` on
 * failure. Only meaningful for emulators. Never throws.
 */
export async function runAdbEmuAvdName(adbPath: string, serial: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(adbPath, ["-s", serial, "emu", "avd", "name"]);
    return stdout;
  } catch (error) {
    console.error(`[android-utils] Failed to read AVD name for ${serial}:`, error);
    return null;
  }
}

/** Build the `adb -s <serial> emu kill` args. */
export function buildEmuKillArgs(serial: string): string[] {
  return ["-s", serial, "emu", "kill"];
}

/**
 * Run `adb -s <serial> emu kill` to stop a running emulator. Returns `true` on
 * success, `false` on failure. Never throws.
 */
export async function runAdbEmuKill(adbPath: string, serial: string): Promise<boolean> {
  try {
    await execFileAsync(adbPath, buildEmuKillArgs(serial));
    return true;
  } catch (error) {
    console.error(`[android-utils] Failed to run \`adb -s ${serial} emu kill\`:`, error);
    return false;
  }
}
