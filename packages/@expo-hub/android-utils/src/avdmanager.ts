import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseConfigIni } from "./parse-config-ini";

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
