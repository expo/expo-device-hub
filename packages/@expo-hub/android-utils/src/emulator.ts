import { type ChildProcess, spawn } from "node:child_process";
import type { BootDeviceOptions } from "./types";

/** The adb serial for an emulator started on the given console port. */
export function emulatorSerial(port: number): string {
  return `emulator-${port}`;
}

/** Build the `emulator` arguments for a headless (windowless) boot. */
export function buildEmulatorArgs(options: BootDeviceOptions): string[] {
  return [
    "-avd",
    options.name,
    "-no-window",
    "-no-audio",
    "-gpu",
    "auto-no-window",
    "-no-boot-anim",
    "-port",
    String(options.port),
  ];
}

/**
 * Spawn a detached, headless `emulator` process.
 *
 * The child is fully detached (its own process group, ignored stdio, `unref`ed)
 * so it keeps running after the parent exits. Returns the {@link ChildProcess},
 * or `null` if it could not be spawned. Never throws.
 */
export function spawnEmulator(
  emulatorPath: string,
  options: BootDeviceOptions,
): ChildProcess | null {
  try {
    const child = spawn(emulatorPath, buildEmulatorArgs(options), {
      detached: true,
      stdio: "ignore",
    });

    child.on("error", (error) => {
      console.error("[android-utils] `emulator` process error:", error);
    });
    child.unref();

    return child;
  } catch (error) {
    console.error("[android-utils] Failed to spawn `emulator`:", error);
    return null;
  }
}
