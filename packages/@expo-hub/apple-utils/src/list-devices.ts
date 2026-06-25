import { runDevicectlListDevices } from "./devicectl";
import { parseDevicesJson } from "./parse-devices";
import type { AppleDevice } from "./types";

/**
 * List the Apple devices known to `devicectl`.
 *
 * Returns the `result.devices` array from `devicectl list devices`, or an empty
 * array if devicectl is unavailable or its output cannot be parsed. Never
 * throws.
 */
export async function listDevices(): Promise<AppleDevice[]> {
  try {
    const json = await runDevicectlListDevices();
    if (!json) return [];

    return parseDevicesJson(json);
  } catch (error) {
    console.error("[apple-utils] Failed to list devices:", error);
    return [];
  }
}
