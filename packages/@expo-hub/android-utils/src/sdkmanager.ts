import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run `sdkmanager --list_installed` and return its stdout, or `null` on failure.
 * Never throws.
 */
export async function runSdkmanagerListInstalled(sdkmanagerPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(sdkmanagerPath, ["--list_installed"]);
    return stdout;
  } catch (error) {
    console.error("[android-utils] Failed to run `sdkmanager --list_installed`:", error);
    return null;
  }
}
