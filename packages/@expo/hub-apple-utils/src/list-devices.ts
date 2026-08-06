import { type AppleUtilsResult, reportError, result } from "./errors";
import { parseDevicesJson } from "./parse-devices";
import { runSimctl } from "./simctl";
import type { AppleDevice } from "./types";

/**
 * List the simulator devices known to `simctl`.
 *
 * The result's `value` contains the flattened device arrays from
 * `xcrun simctl list devices --json`, or an empty array when unavailable. The
 * first invocation-specific failure is returned in `error`. Never throws.
 */
export async function listDevices(): Promise<AppleUtilsResult<AppleDevice[]>> {
  try {
    // `devicectl` 518.33 on EAS VMs always returned an empty devices array.
    const listed = await runSimctl(["list", "devices", "--json"]);
    if (listed.error) return result([], listed.error);
    if (!listed.value) return result([]);

    return parseDevicesJson(listed.value);
  } catch (error) {
    return result([], reportError("[apple-utils] Failed to list devices:", error));
  }
}
