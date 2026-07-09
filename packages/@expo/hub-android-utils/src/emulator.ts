import { type ChildProcess, spawn } from "node:child_process";
import type { BootDeviceOptions } from "./types";

/** The adb serial for an emulator started on the given console port. */
export function emulatorSerial(port: number): string {
  return `emulator-${port}`;
}

/**
 * Build the `emulator` arguments for a boot.
 * Always use `host` GPU, `auto` results in low fps when using with `-no-window`
 * or the windows is in the background. (~10fps scrcpy, or ~30fps with grpc streaming)
 */
export function buildEmulatorArgs(options: BootDeviceOptions): string[] {
  return [
    "-avd",
    options.name,
    "-no-audio",
    "-no-window",
    "-gpu",
    "host",
    "-no-boot-anim",
    "-port",
    String(options.port),
  ];
}

/**
 * The boot invocation as a human-runnable shell command — what error messages
 * offer the user to reproduce a failed boot with the full emulator output
 * visible in their terminal.
 */
export function formatEmulatorCommand(emulatorPath: string, options: BootDeviceOptions): string {
  return [emulatorPath, ...buildEmulatorArgs(options)]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
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
