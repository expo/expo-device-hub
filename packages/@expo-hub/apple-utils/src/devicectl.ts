import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run `devicectl list devices` and return the raw JSON it writes to disk.
 *
 * devicectl is invoked with `--quiet` and `--json-output <file>`, so the device
 * list is written to a throwaway temp file that is always cleaned up. Returns
 * `null` when the command cannot be run. Never throws.
 */
export async function runDevicectlListDevices(): Promise<string | null> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "apple-utils-"));
    const outputFile = join(dir, "devices.json");

    await execFileAsync("devicectl", ["list", "devices", "--json-output", outputFile, "--quiet"]);

    return await readFile(outputFile, "utf8");
  } catch (error) {
    console.error("[apple-utils] Failed to run `devicectl list devices`:", error);
    return null;
  } finally {
    await cleanup(dir);
  }
}

async function cleanup(dir: string | null): Promise<void> {
  if (!dir) return;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    console.error("[apple-utils] Failed to clean up temp directory:", error);
  }
}
