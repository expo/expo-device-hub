import { homedir } from "node:os";
import { runAvdmanagerListDevice } from "./avdmanager";
import { parseDeviceProfiles } from "./parse-device-profiles";
import { resolveAvdmanagerPath } from "./sdk-paths";
import type { AndroidDeviceProfile } from "./types";

/**
 * List the device profiles (hardware definitions) known to the SDK.
 *
 * Wraps `avdmanager list device`, returning one entry per profile. Each `id` is
 * the stable identifier to pass to `avdmanager create avd -d <id>`. Resolves
 * `avdmanager` from `ANDROID_HOME` / `ANDROID_SDK_ROOT` (falling back to the
 * default macOS SDK location). Returns an empty array on any failure. Never
 * throws.
 */
export async function listDeviceProfiles(): Promise<AndroidDeviceProfile[]> {
  try {
    const avdmanager = resolveAvdmanagerPath(process.env, homedir());
    const stdout = await runAvdmanagerListDevice(avdmanager);
    return stdout ? parseDeviceProfiles(stdout) : [];
  } catch (error) {
    console.error("[android-utils] Failed to list device profiles:", error);
    return [];
  }
}
