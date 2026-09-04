import { type ChildProcess, spawn } from "node:child_process";
import { type AndroidUtilsResult, reportError, result } from "./errors";
import type { BootDeviceOptions } from "./types";

/** The adb serial for an emulator started on the given console port. */
export function emulatorSerial(port: number): string {
  return `emulator-${port}`;
}

/**
 * Build the `emulator` arguments for a boot.
 * Let the emulator choose the GPU backend that best matches the host.
 */
export function buildEmulatorArgs(options: BootDeviceOptions): string[] {
  return [
    "-avd",
    options.name,
    "-no-audio",
    "-no-window",
    "-gpu",
    "auto",
    "-no-boot-anim",
    "-port",
    String(options.port),
    ...(options.extraArgs ?? []),
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
 * so it keeps running after the parent exits. Resolves with the
 * {@link ChildProcess}, or `null` plus `error` if it could not be spawned.
 */
export function spawnEmulator(
  emulatorPath: string,
  options: BootDeviceOptions,
): Promise<AndroidUtilsResult<ChildProcess | null>> {
  try {
    const child = spawn(emulatorPath, buildEmulatorArgs(options), {
      detached: true,
      stdio: "ignore",
    });

    return new Promise((resolve) => {
      const onError = (error: Error) => {
        resolve(result(null, reportError("[android-utils] Failed to spawn `emulator`:", error)));
      };
      child.once("error", onError);
      child.once("spawn", () => {
        child.removeListener("error", onError);
        child.unref();
        resolve(result(child));
      });
    });
  } catch (error) {
    return Promise.resolve(
      result(null, reportError("[android-utils] Failed to spawn `emulator`:", error)),
    );
  }
}
