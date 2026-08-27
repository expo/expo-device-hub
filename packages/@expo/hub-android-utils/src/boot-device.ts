import { homedir } from "node:os";
import { emulatorSerial, formatEmulatorCommand, spawnEmulator } from "./emulator";
import { type AndroidUtilsResult, reportError, result } from "./errors";
import { resolveEmulatorPath } from "./sdk-paths";
import type { BootDeviceOptions, BootedDevice } from "./types";

/**
 * Boot an AVD headlessly via the `emulator` binary.
 *
 * Spawns a detached, windowless emulator and returns as soon as the process is
 * launched — not once Android has finished booting; track readiness with adb
 * via the returned `serial`. If host GPU rendering is unavailable, the process
 * is retried once with software rendering. `exited` follows that retry and
 * resolves if the active process dies — before the device is adb-online that
 * means the boot failed. Emulator output is otherwise discarded (the detached
 * child outlives us), so failure reports point the user at re-running the
 * returned `command` to see it. Resolves `emulator` from `ANDROID_HOME` /
 * `ANDROID_SDK_ROOT` (falling back to the default macOS SDK location). The
 * result's `value` is `null` if the process could not be spawned, with the
 * invocation-specific failure in `error`.
 */
export async function bootDevice(
  options: BootDeviceOptions,
): Promise<AndroidUtilsResult<BootedDevice | null>> {
  try {
    const emulator = resolveEmulatorPath(process.env, homedir());
    const spawned = await spawnEmulator(emulator, options);
    if (spawned.error || !spawned.value) return result(null, spawned.error);
    const running = spawned.value;

    return result({
      serial: emulatorSerial(options.port),
      get pid() {
        return running.child.pid ?? null;
      },
      get command() {
        return formatEmulatorCommand(emulator, options, running.gpuMode);
      },
      exited: running.exited,
    });
  } catch (error) {
    return result(null, reportError("[android-utils] Failed to boot device:", error));
  }
}
