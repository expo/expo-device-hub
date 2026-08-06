import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type AndroidUtilsResult, reportError, result } from "./errors";

const execFileAsync = promisify(execFile);

/**
 * Run `sdkmanager --list_installed` and return its stdout, or `null` on failure.
 * Never throws.
 */
export async function runSdkmanagerListInstalled(
  sdkmanagerPath: string,
): Promise<AndroidUtilsResult<string | null>> {
  try {
    const { stdout } = await execFileAsync(sdkmanagerPath, ["--list_installed"]);
    return result(stdout);
  } catch (error) {
    return result(
      null,
      reportError("[android-utils] Failed to run `sdkmanager --list_installed`:", error),
    );
  }
}
