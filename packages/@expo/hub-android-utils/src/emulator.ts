import { type ChildProcess, spawn } from "node:child_process";
import { parse, quote } from "shell-quote";
import { type AndroidUtilsResult, reportError, result } from "./errors";
import type { BootDeviceOptions } from "./types";

/** The adb serial for an emulator started on the given console port. */
export function emulatorSerial(port: number): string {
  return `emulator-${port}`;
}

/** Whether an adb serial names an emulator (`emulator-<port>`) rather than physical hardware. */
export function isEmulatorSerial(serial: string): boolean {
  return /^emulator-\d+$/.test(serial);
}

/** An emulator process found by its command line. */
export interface EmulatorProcess {
  avdName: string;
  /** Console port from `-port`; the adb serial is `emulator-<port>`. */
  port: number | null;
}

/**
 * The AVD and console port of an `emulator` or `qemu-system-*` command line,
 * or `null` for any other process. The AVD is named by `-avd <name>` or
 * `@<name>`; `-ports <console>,<adb>` names the console port first. `ps`
 * joins the arguments with spaces, which AVD names never contain.
 */
export function parseEmulatorArgs(args: string): EmulatorProcess | null {
  const tokens = args.split(/\s+/).filter(Boolean);
  const binary = tokens.findIndex((token) => {
    const name = token.slice(token.lastIndexOf("/") + 1);
    return name === "emulator" || name.startsWith("qemu-system-");
  });
  if (binary === -1) return null;

  let avdName: string | null = null;
  let port: number | null = null;
  for (let index = binary + 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    const next = tokens[index + 1];
    if ((token === "-avd" || token === "--avd") && next) {
      avdName ??= next;
      index++;
    } else if (token.startsWith("@") && token.length > 1) {
      avdName ??= token.slice(1);
    } else if ((token === "-port" || token === "-ports") && next && /^\d+(,\d+)?$/.test(next)) {
      port ??= Number(next.split(",")[0]);
      index++;
    }
  }
  return avdName ? { avdName, port } : null;
}

/** Split an environment string into argv without running a shell. */
function parseExtraArgs(value: string): string[] {
  // Preserve $NAME literally; spawn does not perform shell expansion.
  return parse(value, (name) => `$${name}`).map((arg) => {
    if (typeof arg !== "string") {
      throw new Error("Invalid EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS: quote shell syntax");
    }
    return arg;
  });
}

/**
 * Build the `emulator` arguments for a boot.
 * Let the emulator choose the GPU backend that best matches the host.
 * `EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS` is appended last, with shell-style quoting.
 */
export function buildEmulatorArgs(options: BootDeviceOptions, env = process.env): string[] {
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
    ...(env.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS
      ? parseExtraArgs(env.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS)
      : []),
  ];
}

/**
 * The boot invocation as a human-runnable shell command — what error messages
 * offer the user to reproduce a failed boot with the full emulator output
 * visible in their terminal.
 */
export function formatEmulatorCommand(emulatorPath: string, options: BootDeviceOptions): string {
  return quote([emulatorPath, ...buildEmulatorArgs(options)]);
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
