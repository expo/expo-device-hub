import { homedir } from "node:os";
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
 * to the default macOS SDK location). Returns an empty array on any failure.
 * Never throws.
 */
export async function listSystemImages(): Promise<AndroidSystemImage[]> {
  try {
    const sdkmanager = resolveSdkmanagerPath(process.env, homedir());
    const stdout = await runSdkmanagerListInstalled(sdkmanager);
    return stdout ? parseSystemImages(stdout) : [];
  } catch (error) {
    console.error("[android-utils] Failed to list system images:", error);
    return [];
  }
}
