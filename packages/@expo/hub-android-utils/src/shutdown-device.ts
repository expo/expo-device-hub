import { homedir } from "node:os";
import { runAdbEmuKill } from "./adb";
import { type AndroidUtilsResult, reportError, result } from "./errors";
import { resolveAdbPath } from "./sdk-paths";
import type { ShutdownDeviceOptions } from "./types";

/**
 * Shut down a running emulator via `adb -s <serial> emu kill`.
 *
 * Resolves `adb` from `ANDROID_HOME` / `ANDROID_SDK_ROOT` (falling back to the
 * default macOS SDK location). The result's `value` is `true` on success and
 * `false` on failure, with the invocation-specific failure in `error`.
 */
export async function shutdownDevice(
  options: ShutdownDeviceOptions,
): Promise<AndroidUtilsResult<boolean>> {
  try {
    const adb = resolveAdbPath(process.env, homedir());
    return await runAdbEmuKill(adb, options.serial);
  } catch (error) {
    return result(false, reportError("[android-utils] Failed to shut down device:", error));
  }
}
