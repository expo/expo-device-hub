import { homedir } from "node:os";
import { runAvdmanagerListDevice } from "./avdmanager";
import { type AndroidUtilsResult, reportError, result } from "./errors";
import { parseDeviceProfiles } from "./parse-device-profiles";
import { resolveAvdmanagerPath } from "./sdk-paths";
import type { AndroidDeviceProfile } from "./types";

/**
 * List the device profiles (hardware definitions) known to the SDK.
 *
 * Wraps `avdmanager list device`, returning one entry per profile. Each `id` is
 * the stable identifier to pass to `avdmanager create avd -d <id>`. Resolves
 * `avdmanager` from `ANDROID_HOME` / `ANDROID_SDK_ROOT` (falling back to the
 * default macOS SDK location). The result's `value` is empty on failure, with
 * the invocation-specific failure in `error`.
 */
export async function listDeviceProfiles(): Promise<AndroidUtilsResult<AndroidDeviceProfile[]>> {
  try {
    const avdmanager = resolveAvdmanagerPath(process.env, homedir());
    const listed = await runAvdmanagerListDevice(avdmanager);
    if (listed.error) return result([], listed.error);
    return result(listed.value ? parseDeviceProfiles(listed.value) : []);
  } catch (error) {
    return result([], reportError("[android-utils] Failed to list device profiles:", error));
  }
}
