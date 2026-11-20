import { readCoreDeviceVersion } from "./core-device-version";
import { runDevicectlListDevices } from "./devicectl";
import { type AppleUtilsResult, reportError, result } from "./errors";
import { parsePhysicalDevicesJson } from "./parse-physical-devices";
import { physicalDeviceUnsupportedReason } from "./physical-device-support";
import type { ApplePhysicalDeviceListing } from "./types";

/**
 * List the iPhones and iPads paired with this Mac, through `devicectl`.
 *
 * Each device carries the reason it cannot stream yet, or null. The first failure is returned in
 * `error`, with the devices that could still be read. Never throws.
 */
export async function listPhysicalDevices(): Promise<
  AppleUtilsResult<ApplePhysicalDeviceListing[]>
> {
  try {
    const [listed, coreDevice] = await Promise.all([
      runDevicectlListDevices(),
      readCoreDeviceVersion(),
    ]);
    if (listed.error || !listed.value) return result([], listed.error ?? coreDevice.error);

    const parsed = parsePhysicalDevicesJson(listed.value);
    return result(
      parsed.value.map((device) => ({
        ...device,
        unsupportedReason: physicalDeviceUnsupportedReason(device, coreDevice.value),
      })),
      parsed.error ?? coreDevice.error,
    );
  } catch (error) {
    return result([], reportError("[apple-utils] Failed to list physical devices:", error));
  }
}
