import { type ApplePhysicalDeviceListing } from "@expo/hub-apple-utils";

import { type HubDevice } from "./devices";

/**
 * A phone is always booted: Hub cannot boot, shut down, or remove it. Its id is the hardware
 * UDID, the id that serve-sim streams it under.
 */
export function physicalIosHubDevice(device: ApplePhysicalDeviceListing): HubDevice {
  return {
    id: device.udid,
    name: device.name,
    version: device.osVersion ? `${device.platform} ${device.osVersion}` : device.platform,
    platform: "ios",
    booted: true,
    physical: true,
    supported: device.unsupportedReason === null && device.deviceType === "iPhone",
    ...(device.unsupportedReason ? { unsupportedReason: device.unsupportedReason } : {}),
    model: device.marketingName,
    deviceModel: null,
  };
}
