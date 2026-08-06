import { homedir } from "node:os";
import { type AndroidUtilsResult, reportError, result } from "./errors";
import { parseSystemImages } from "./parse-system-images";
import { resolveSdkmanagerPath } from "./sdk-paths";
import { runSdkmanagerListInstalled } from "./sdkmanager";
import type { AndroidSystemImage } from "./types";

/**
 * List the installed system images known to the SDK.
 *
 * Wraps `sdkmanager --list_installed`, keeping only `system-images;…` packages.
 * Each `package` is the value to pass to `avdmanager create avd -k <package>`.
 * Resolves `sdkmanager` from `ANDROID_HOME` / `ANDROID_SDK_ROOT` (falling back
 * to the default macOS SDK location). The result's `value` is empty on failure,
 * with the invocation-specific failure in `error`.
 */
export async function listSystemImages(): Promise<AndroidUtilsResult<AndroidSystemImage[]>> {
  try {
    const sdkmanager = resolveSdkmanagerPath(process.env, homedir());
    const listed = await runSdkmanagerListInstalled(sdkmanager);
    if (listed.error) return result([], listed.error);
    return result(listed.value ? parseSystemImages(listed.value) : []);
  } catch (error) {
    return result([], reportError("[android-utils] Failed to list system images:", error));
  }
}
