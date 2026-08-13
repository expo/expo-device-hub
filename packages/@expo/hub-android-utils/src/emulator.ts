import { type ChildProcess, spawn } from "node:child_process";
import { type AndroidUtilsResult, logDebug, reportError, result } from "./errors";
import type { BootDeviceOptions, EmulatorExit } from "./types";

const HARDWARE_GPU_ERROR = "Your GPU cannot be used for hardware rendering";

export type EmulatorGpuMode = "host" | "software";

export interface SpawnedEmulator {
  /** The active process, updated if startup falls back to software rendering. */
  readonly child: ChildProcess;
  /** The active GPU mode, updated if startup falls back to software rendering. */
  readonly gpuMode: EmulatorGpuMode;
  /** Resolves when the active process exits without another retry. */
  readonly exited: Promise<EmulatorExit>;
}

/** The adb serial for an emulator started on the given console port. */
export function emulatorSerial(port: number): string {
  return `emulator-${port}`;
}

/**
 * Build the `emulator` arguments for a boot.
 * Prefer the `host` GPU because `auto` results in low fps with `-no-window` or
 * when the window is in the background. Software rendering is used only when
 * the host attempt reports that hardware rendering is unavailable.
 */
export function buildEmulatorArgs(
  options: BootDeviceOptions,
  gpuMode: EmulatorGpuMode = "host",
): string[] {
  return [
    "-avd",
    options.name,
    "-no-audio",
    "-no-window",
    "-gpu",
    gpuMode,
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
export function formatEmulatorCommand(
  emulatorPath: string,
  options: BootDeviceOptions,
  gpuMode: EmulatorGpuMode = "host",
): string {
  return [emulatorPath, ...buildEmulatorArgs(options, gpuMode)]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

/**
 * Spawn a detached, headless `emulator` process.
 *
 * The child is fully detached (its own process group, unreferenced stdio,
 * `unref`ed) so it keeps running after the parent exits. If the emulator says
 * host rendering is unavailable, the host attempt is stopped and retried once
 * with software rendering. Resolves with the managed process lifecycle, or
 * `null` plus `error` if the first process could not be spawned.
 */
export async function spawnEmulator(
  emulatorPath: string,
  options: BootDeviceOptions,
): Promise<AndroidUtilsResult<SpawnedEmulator | null>> {
  const initial = await spawnEmulatorProcess(emulatorPath, options, "host");
  if (initial.error || !initial.value) return result(null, initial.error);

  let activeChild = initial.value;
  let activeGpuMode: EmulatorGpuMode = "host";

  const exited = new Promise<EmulatorExit>((resolve) => {
    const monitor = (child: ChildProcess, gpuMode: EmulatorGpuMode): void => {
      let fallbackRequested = false;
      let finished = false;
      let stderrTail = "";

      function cleanup(): void {
        child.stderr?.removeListener("data", onStderr);
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
      }

      function onStderr(chunk: Buffer | string): void {
        if (finished || gpuMode !== "host" || fallbackRequested) return;

        stderrTail = `${stderrTail}${chunk}`.slice(-HARDWARE_GPU_ERROR.length * 2);
        if (!stderrTail.includes(HARDWARE_GPU_ERROR)) return;

        fallbackRequested = true;
        logDebug(
          "[android-utils] Hardware GPU rendering unavailable; retrying `emulator` with software rendering.",
        );
        child.kill();
      }

      function onError(error: Error): void {
        if (finished) return;
        finished = true;
        cleanup();
        resolve({
          code: null,
          signal: null,
          error: reportError("[android-utils] `emulator` process error:", error),
        });
      }

      async function onClose(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
        if (finished) return;
        finished = true;
        cleanup();

        if (!fallbackRequested) {
          resolve({ code, signal, error: null });
          return;
        }

        const retried = await spawnEmulatorProcess(emulatorPath, options, "software");
        if (retried.error || !retried.value) {
          resolve({ code: null, signal: null, error: retried.error });
          return;
        }

        activeChild = retried.value;
        activeGpuMode = "software";
        monitor(activeChild, activeGpuMode);
      }

      child.stderr?.on("data", onStderr);
      child.once("error", onError);
      child.once("close", onClose);
    };

    monitor(activeChild, activeGpuMode);
  });

  return result({
    get child() {
      return activeChild;
    },
    get gpuMode() {
      return activeGpuMode;
    },
    exited,
  });
}

function spawnEmulatorProcess(
  emulatorPath: string,
  options: BootDeviceOptions,
  gpuMode: EmulatorGpuMode,
): Promise<AndroidUtilsResult<ChildProcess | null>> {
  try {
    const child = spawn(emulatorPath, buildEmulatorArgs(options, gpuMode), {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });

    return new Promise((resolve) => {
      const onError = (error: Error) => {
        resolve(result(null, reportError("[android-utils] Failed to spawn `emulator`:", error)));
      };
      child.once("error", onError);
      child.once("spawn", () => {
        child.removeListener("error", onError);
        child.unref();
        const stderr = child.stderr as (typeof child.stderr & { unref(): void }) | null;
        stderr?.unref();
        resolve(result(child));
      });
    });
  } catch (error) {
    return Promise.resolve(
      result(null, reportError("[android-utils] Failed to spawn `emulator`:", error)),
    );
  }
}
