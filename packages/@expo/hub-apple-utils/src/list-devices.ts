import { runDevicectlListDevices } from "./devicectl";
import { type AppleUtilsResult, reportError, result } from "./errors";
import { parseDevicesJson } from "./parse-devices";
import type { AppleDevice } from "./types";

/**
 * List the Apple devices known to `devicectl`.
 *
 * The result's `value` is the `result.devices` array from devicectl, or an empty
 * array when unavailable. The first invocation-specific failure is returned in
 * `error`.
 */
export async function listDevices(): Promise<AppleUtilsResult<AppleDevice[]>> {
  try {
    const listed = await runDevicectlListDevices();
    if (listed.error) return result([], listed.error);
    if (!listed.value) return result([]);

    return parseDevicesJson(listed.value);
  } catch (error) {
    return result([], reportError("[apple-utils] Failed to list devices:", error));
  }
}
