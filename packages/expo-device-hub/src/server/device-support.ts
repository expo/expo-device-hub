import { type AndroidDevice, type AndroidDeviceProfile } from "@expo/hub-android-utils";
import { type AppleDevice, type AppleSimulatorDeviceType } from "@expo/hub-apple-utils";
import { type DeviceModelId } from "@expo/hub-components";

const IPHONE_18_PRO_DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro";
const IPHONE_DUO_DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo";

/** The 3D model of a simulator, from the device type that simctl reports. */
export function appleDevice3DModel(
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

/**
 * The 3D model of an emulator's hardware profile, or of a physical device's
 * model name. An emulator without profile metadata gets no model: its AVD name
 * is the user's and can name another device.
 */
export function androidDevice3DModel(device: AndroidDevice): DeviceModelId | null {
  const profile =
    device.type === "device"
      ? (device.properties["ro.product.model"] ?? device.name)
      : (device.config["hw.device.name"] ?? device.properties.Device);
  switch (normalizeDeviceName(profile)) {
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

function normalizeDeviceName(candidate: string | undefined): string | null {
  return candidate?.toLowerCase().replaceAll("_", " ").replaceAll("-", " ").trim() ?? null;
}
