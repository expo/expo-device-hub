import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type AndroidUtilsResult, reportError, result } from "./errors";

const execFileAsync = promisify(execFile);

/**
 * Run `adb devices -l` and return its stdout, or `null` on failure.
 * Never throws.
 */
export async function runAdbDevices(adbPath: string): Promise<AndroidUtilsResult<string | null>> {
  try {
    const { stdout } = await execFileAsync(adbPath, ["devices", "-l"]);
    return result(stdout);
  } catch (error) {
    return result(null, reportError("[android-utils] Failed to run `adb devices -l`:", error));
  }
}

/**
 * Run `adb -s <serial> shell getprop` and return its stdout, or `null` on
 * failure. Never throws.
 */
export async function runAdbGetprop(
  adbPath: string,
  serial: string,
): Promise<AndroidUtilsResult<string | null>> {
  try {
    const { stdout } = await execFileAsync(adbPath, ["-s", serial, "shell", "getprop"]);
    return result(stdout);
  } catch (error) {
    return result(
      null,
      reportError(`[android-utils] Failed to read getprop for ${serial}:`, error),
    );
  }
}

/**
 * Run `adb -s <serial> emu avd name` and return its stdout, or `null` on
 * failure. Only meaningful for emulators. Never throws.
 */
export async function runAdbEmuAvdName(
  adbPath: string,
  serial: string,
): Promise<AndroidUtilsResult<string | null>> {
  try {
    const { stdout } = await execFileAsync(adbPath, ["-s", serial, "emu", "avd", "name"]);
    return result(stdout);
  } catch (error) {
    return result(
      null,
      reportError(`[android-utils] Failed to read AVD name for ${serial}:`, error),
    );
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
export async function runAdbEmuKill(
  adbPath: string,
  serial: string,
): Promise<AndroidUtilsResult<boolean>> {
  try {
    await execFileAsync(adbPath, buildEmuKillArgs(serial));
    return result(true);
  } catch (error) {
    return result(
      false,
      reportError(`[android-utils] Failed to run \`adb -s ${serial} emu kill\`:`, error),
    );
  }
}
