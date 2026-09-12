import { type AndroidUtilsResult, reportError, result } from "./errors";
import { execSdkTool } from "./exec-sdk-tool";

/**
 * Run `sdkmanager --list_installed` and return its stdout, or `null` on failure.
 * Never throws.
 */
export async function runSdkmanagerListInstalled(
  sdkmanagerPath: string,
): Promise<AndroidUtilsResult<string | null>> {
  try {
    const { stdout } = await execSdkTool(sdkmanagerPath, ["--list_installed"]);
    return result(stdout);
  } catch (error) {
    return result(
      null,
      reportError("[android-utils] Failed to run `sdkmanager --list_installed`:", error),
    );
  }
}
