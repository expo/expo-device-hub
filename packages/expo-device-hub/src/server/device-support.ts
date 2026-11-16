import { type AndroidDevice, type AndroidDeviceProfile } from "@expo/hub-android-utils";
import { type AppleDevice, type AppleSimulatorDeviceType } from "@expo/hub-apple-utils";

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

/** Hub supports Pixel phones (including foldables) and the SDK's Small/Medium Phone profiles. */
export function isSupportedAndroidDeviceProfile(
  profile: Pick<AndroidDeviceProfile, "id" | "name" | "tag">,
): boolean {
  return profile.tag === null && isSupportedAndroidPhone(profile.id, profile.name);
}

/** Allow physical Android devices; classify AVDs from their profile metadata. */
export function isSupportedAndroidDevice(device: AndroidDevice): boolean {
  if (device.type === "device") {
    return true;
  }
  const profile = device.config["hw.device.name"] ?? device.properties.Device;
  return isSupportedAndroidPhone(profile ?? device.name);
}

function isIphoneDeviceTypeIdentifier(identifier: string | null): boolean {
  return identifier?.includes("iPhone") ?? false;
}

// @ref LLP 0000#android-supported-phone-profiles — share the phone policy between existing AVDs and creation
function isSupportedAndroidPhone(...candidates: Array<string | undefined>): boolean {
  return candidates.some((candidate) => {
    if (!candidate) return false;
    const normalized = candidate.trim().toLowerCase().replaceAll("_", " ").replaceAll("-", " ");
    const pixelPhone =
      /pixel/.test(normalized) && !/(?:tablet|watch|buds|pixel c)/.test(normalized);
    // avdmanager's existing-AVD Device field appends the profile's OEM.
    const genericPhone = /^(?:small|medium) phone(?: \(generic\))?$/.test(normalized);
    return pixelPhone || genericPhone;
  });
}
