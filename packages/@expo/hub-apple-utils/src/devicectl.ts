import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AppleUtilsResult, reportError, result } from "./errors";

const execFileAsync = promisify(execFile);

const LIST_TIMEOUT_MS = 10_000;

/**
 * Run `xcrun devicectl list devices --json-output <file>` and return the file's JSON text.
 *
 * devicectl writes its machine-readable output only to a file; stdout is a table for people. The
 * file goes in a private temporary directory that is removed afterwards. Never throws.
 */
export async function runDevicectlListDevices(): Promise<AppleUtilsResult<string | null>> {
  const directory = await mkdtemp(join(tmpdir(), "hub-devicectl-"));
  const output = join(directory, "devices.json");
  try {
    await execFileAsync("xcrun", ["devicectl", "list", "devices", "--json-output", output], {
      timeout: LIST_TIMEOUT_MS,
    });
    return result(await readFile(output, "utf8"));
  } catch (error) {
    return result(
      null,
      reportError("[apple-utils] Failed to run `xcrun devicectl list devices`:", error),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
