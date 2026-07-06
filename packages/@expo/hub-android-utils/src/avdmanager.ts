import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseConfigIni } from "./parse-config-ini";
import type { CreateDeviceOptions } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Run `avdmanager list avd` and return its stdout, or `null` on failure.
 * Never throws.
 */
export async function runAvdmanagerListAvd(avdmanagerPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(avdmanagerPath, ["list", "avd"]);
    return stdout;
  } catch (error) {
    console.error("[android-utils] Failed to run `avdmanager list avd`:", error);
    return null;
  }
}

/**
 * Run `avdmanager list device` and return its stdout, or `null` on failure.
 * Never throws.
 */
export async function runAvdmanagerListDevice(avdmanagerPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(avdmanagerPath, ["list", "device"]);
    return stdout;
  } catch (error) {
    console.error("[android-utils] Failed to run `avdmanager list device`:", error);
    return null;
  }
}

/**
 * Throw if `device` is empty. A missing device makes `avdmanager` drop into its
 * interactive "create a custom hardware profile?" prompt, which would hang.
 */
export function assertDevice(device: string): void {
  // `!device` guards missing/empty; `.trim()` also rejects whitespace-only ids.
  if (!device || !device.trim()) {
    throw new Error('[android-utils] `device` is required to create an AVD (e.g. "pixel_6").');
  }
}

/**
 * Build the `avdmanager create avd` arguments from {@link CreateDeviceOptions}.
 *
 * Throws via {@link assertDevice} when `device` is empty.
 */
export function buildCreateAvdArgs(options: CreateDeviceOptions): string[] {
  assertDevice(options.device);

  const args = [
    "create",
    "avd",
    "--name",
    options.name,
    "--package",
    options.package,
    "--device",
    options.device,
  ];

  // `--force` goes last so it never splits a flag/value pair.
  if (options.force) args.push("--force");

  return args;
}

/**
 * Run `avdmanager create avd …` and return its stdout, or `null` on failure.
 *
 * The required `--device` (see {@link CreateDeviceOptions}) keeps `avdmanager`
 * non-interactive: it only prompts "Do you wish to create a custom hardware
 * profile?" when no device is given. Throws if `device` is empty; returns
 * `null` on any execution failure.
 */
export async function runAvdmanagerCreateAvd(
  avdmanagerPath: string,
  options: CreateDeviceOptions,
): Promise<string | null> {
  const args = buildCreateAvdArgs(options);

  try {
    const { stdout } = await execFileAsync(avdmanagerPath, args);
    return stdout;
  } catch (error) {
    console.error("[android-utils] Failed to run `avdmanager create avd`:", error);
    return null;
  }
}

/** Throw if `name` is empty — `avdmanager delete avd` needs an AVD name. */
export function assertName(name: string): void {
  if (!name || !name.trim()) {
    throw new Error(
      '[android-utils] `name` is required to delete an AVD (e.g. "expo-emu-host-0").',
    );
  }
}

/**
 * Build the `avdmanager delete avd --name <name>` arguments.
 *
 * Throws via {@link assertName} when `name` is empty.
 */
export function buildDeleteAvdArgs(name: string): string[] {
  assertName(name);
  return ["delete", "avd", "--name", name];
}

/**
 * Run `avdmanager delete avd --name <name>` and return its stdout, or `null` on
 * failure. Throws via {@link assertName} when `name` is empty.
 */
export async function runAvdmanagerDeleteAvd(
  avdmanagerPath: string,
  name: string,
): Promise<string | null> {
  const args = buildDeleteAvdArgs(name);

  try {
    const { stdout } = await execFileAsync(avdmanagerPath, args);
    return stdout;
  } catch (error) {
    console.error("[android-utils] Failed to run `avdmanager delete avd`:", error);
    return null;
  }
}

/**
 * Read and parse `<avdPath>/config.ini`. Returns an empty object when the path
 * is missing or the file cannot be read. Never throws.
 */
export async function readAvdConfig(avdPath: string | null): Promise<Record<string, string>> {
  if (!avdPath) return {};

  try {
    const text = await readFile(join(avdPath, "config.ini"), "utf8");
    return parseConfigIni(text);
  } catch (error) {
    console.error(`[android-utils] Failed to read config.ini for ${avdPath}:`, error);
    return {};
  }
}
