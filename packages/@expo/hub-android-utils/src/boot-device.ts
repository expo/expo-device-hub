import { homedir } from "node:os";
import { emulatorSerial, formatEmulatorCommand, spawnEmulator } from "./emulator";
import { resolveEmulatorPath } from "./sdk-paths";
import type { BootDeviceOptions, BootedDevice, EmulatorExit } from "./types";

/**
 * Boot an AVD headlessly via the `emulator` binary.
 *
 * Spawns a detached, windowless emulator and returns as soon as the process is
 * launched — not once Android has finished booting; track readiness with adb
 * via the returned `serial`. `exited` resolves if the process dies — before
 * the device is adb-online that means the boot failed; the emulator's output
 * is discarded (the detached child outlives us), so failure reports point the
 * user at re-running the returned `command` to see it. Resolves `emulator`
 * from `ANDROID_HOME` / `ANDROID_SDK_ROOT` (falling back to the default macOS
 * SDK location). Returns `null` if the process could not be spawned. Never
 * throws.
 */
export function bootDevice(options: BootDeviceOptions): BootedDevice | null {
  try {
    const emulator = resolveEmulatorPath(process.env, homedir());
    const child = spawnEmulator(emulator, options);
    if (!child) return null;

    const exited = new Promise<EmulatorExit>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      // A spawn-level error (e.g. binary vanished) may never reach "exit".
      child.once("error", () => resolve({ code: null, signal: null }));
    });

    return {
      serial: emulatorSerial(options.port),
      pid: child.pid ?? null,
      command: formatEmulatorCommand(emulator, options),
      exited,
    };
  } catch (error) {
    console.error("[android-utils] Failed to boot device:", error);
    return null;
  }
}
