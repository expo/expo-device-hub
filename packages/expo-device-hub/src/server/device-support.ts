import { type AndroidDevice, type AndroidDeviceProfile } from "@expo/hub-android-utils";
import { type AppleDevice, type AppleSimulatorDeviceType } from "@expo/hub-apple-utils";
import { type DeviceFrameProfileId, type DeviceModelId } from "@expo/hub-components";

const IPHONE_17_PRO_DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
const IPHONE_18_PRO_DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro";
const IPHONE_DUO_DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo";
const IPHONE_17_PRO_FRAME = "ios:iphone-17-pro";
const PIXEL_9_FRAME = "android:pixel-9";
const PIXEL_10_PRO_FRAME = "android:pixel-10-pro";

export function appleDeviceTypeFrame(
  deviceType: Pick<AppleSimulatorDeviceType, "identifier">,
): DeviceFrameProfileId | null {
  return deviceType.identifier === IPHONE_17_PRO_DEVICE_TYPE ? IPHONE_17_PRO_FRAME : null;
}

export function appleDeviceFrame(
  device: Pick<AppleDevice, "deviceTypeIdentifier">,
): DeviceFrameProfileId | null {
  return device.deviceTypeIdentifier === IPHONE_17_PRO_DEVICE_TYPE ? IPHONE_17_PRO_FRAME : null;
}

export function androidDeviceProfileFrame(
  profile: Pick<AndroidDeviceProfile, "id" | "name" | "tag">,
): DeviceFrameProfileId | null {
  if (isPixel9(profile.id, profile.name)) return PIXEL_9_FRAME;
  return isPixel10Pro(profile.id, profile.name) ? PIXEL_10_PRO_FRAME : null;
}

export function androidDeviceFrame(device: AndroidDevice): DeviceFrameProfileId | null {
  const profile =
    device.type === "device"
      ? (device.properties["ro.product.model"] ?? device.name)
      : (device.config["hw.device.name"] ?? device.properties.Device);
  if (isPixel9(profile ?? device.name)) return PIXEL_9_FRAME;
  return isPixel10Pro(profile ?? device.name) ? PIXEL_10_PRO_FRAME : null;
}

/** The 3D model of a simulator, from the device type that simctl reports. */
export function appleDeviceModel(
  device: Pick<AppleDevice, "deviceTypeIdentifier">,
): DeviceModelId | null {
  switch (device.deviceTypeIdentifier) {
    case IPHONE_DUO_DEVICE_TYPE:
      return "ios:iphone-duo";
    case IPHONE_18_PRO_DEVICE_TYPE:
      return "ios:iphone-18-pro";
    default:
      return null;
  }
}

/** The 3D model of an emulator's hardware profile, or of a physical device's model name. */
export function androidDeviceModel(device: AndroidDevice): DeviceModelId | null {
  const profile =
    device.type === "device"
      ? (device.properties["ro.product.model"] ?? device.name)
      : (device.config["hw.device.name"] ?? device.properties.Device);
  switch (normalizeDeviceName(profile ?? device.name)) {
    case "pixel 9 pro":
      return "android:pixel-9-pro";
    case "pixel 9 pro fold":
      return "android:pixel-9-pro-fold";
    default:
      return null;
  }
}

/** Hub currently supports and tests iPhone simulator hardware only. */
export function isSupportedAppleDeviceType(
  deviceType: Pick<AppleSimulatorDeviceType, "identifier">,
): boolean {
  return isIphoneDeviceTypeIdentifier(deviceType.identifier);
}

/** Classify an existing simulator from the device-type identifier reported by simctl. */
export function isSupportedAppleDevice(device: Pick<AppleDevice, "deviceTypeIdentifier">): boolean {
  return isIphoneDeviceTypeIdentifier(device.deviceTypeIdentifier);
}

/** Hub currently supports and tests Google Pixel phone emulator profiles only. */
export function isSupportedAndroidDeviceProfile(
  profile: Pick<AndroidDeviceProfile, "id" | "name" | "tag">,
): boolean {
  return profile.tag === null && isPixelPhone(profile.id, profile.name);
}

/** Allow physical Android devices; classify AVDs from their profile metadata. */
export function isSupportedAndroidDevice(device: AndroidDevice): boolean {
  if (device.type === "device") {
    return true;
  }
  const profile = device.config["hw.device.name"] ?? device.properties.Device;
  return isPixelPhone(profile ?? device.name);
}

function isIphoneDeviceTypeIdentifier(identifier: string | null): boolean {
  return identifier?.includes("iPhone") ?? false;
}

function isPixelPhone(...candidates: Array<string | undefined>): boolean {
  return candidates.some((candidate) => {
    if (!candidate) return false;
    const normalized = candidate.toLowerCase().replaceAll("_", " ").replaceAll("-", " ");
    return /pixel/.test(normalized) && !/(?:fold|tablet|watch|buds|pixel c)/.test(normalized);
  });
}

function isPixel10Pro(...candidates: Array<string | undefined>): boolean {
  return candidates.some((candidate) => normalizeDeviceName(candidate) === "pixel 10 pro");
}

function isPixel9(...candidates: Array<string | undefined>): boolean {
  return candidates.some((candidate) => normalizeDeviceName(candidate) === "pixel 9");
}

function normalizeDeviceName(candidate: string | undefined): string | null {
  return candidate?.toLowerCase().replaceAll("_", " ").replaceAll("-", " ").trim() ?? null;
}
