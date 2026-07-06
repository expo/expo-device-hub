import { homedir } from "node:os";
import { runAdbEmuKill } from "./adb";
import { resolveAdbPath } from "./sdk-paths";
import type { ShutdownDeviceOptions } from "./types";

/**
 * Shut down a running emulator via `adb -s <serial> emu kill`.
 *
 * Resolves `adb` from `ANDROID_HOME` / `ANDROID_SDK_ROOT` (falling back to the
 * default macOS SDK location). Returns `true` on success, `false` on any failure
 * (e.g. the emulator is not running). Never throws.
 */
export async function shutdownDevice(options: ShutdownDeviceOptions): Promise<boolean> {
  try {
    const adb = resolveAdbPath(process.env, homedir());
    return await runAdbEmuKill(adb, options.serial);
  } catch (error) {
    console.error("[android-utils] Failed to shut down device:", error);
    return false;
  }
}
