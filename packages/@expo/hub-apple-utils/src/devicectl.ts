import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AppleUtilsResult, reportError, result } from "./errors";

const execFileAsync = promisify(execFile);

/**
 * Run `devicectl list devices` and return the raw JSON it writes to disk.
 *
 * devicectl is invoked with `--quiet` and `--json-output <file>`, so the device
 * list is written to a throwaway temp file that is always cleaned up. The
 * result's `value` is `null` and `error` is set when the command cannot run.
 */
export async function runDevicectlListDevices(): Promise<AppleUtilsResult<string | null>> {
  let dir: string | null = null;
  let command = result<string | null>(null);
  try {
    dir = await mkdtemp(join(tmpdir(), "apple-utils-"));
    const outputFile = join(dir, "devices.json");

    await execFileAsync("devicectl", ["list", "devices", "--json-output", outputFile, "--quiet"]);

    command = result(await readFile(outputFile, "utf8"));
  } catch (error) {
    command = result(
      null,
      reportError("[apple-utils] Failed to run `devicectl list devices`:", error),
    );
  }

  const cleanedUp = await cleanup(dir);
  return command.error ? command : result(command.value, cleanedUp.error);
}

async function cleanup(dir: string | null): Promise<AppleUtilsResult<void>> {
  if (!dir) return result(undefined);
  try {
    await rm(dir, { recursive: true, force: true });
    return result(undefined);
  } catch (error) {
    return result(
      undefined,
      reportError("[apple-utils] Failed to clean up temp directory:", error),
    );
  }
}
