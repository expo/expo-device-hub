import { type AndroidDevice, type AndroidDeviceProfile } from '@expo/hub-android-utils';
import { type AppleDevice, type AppleSimulatorDeviceType } from '@expo/hub-apple-utils';

/** Hub currently supports and tests iPhone simulator hardware only. */
export function isSupportedAppleDeviceType(
  deviceType: Pick<AppleSimulatorDeviceType, 'productFamily'>,
): boolean {
  return deviceType.productFamily === 'iPhone';
}

/** Classify an existing simulator from the device-type identifier reported by simctl. */
export function isSupportedAppleDevice(device: Pick<AppleDevice, 'deviceTypeIdentifier'>): boolean {
  return isIphoneDeviceTypeIdentifier(device.deviceTypeIdentifier);
}

/** Hub currently supports and tests Google Pixel phone emulator profiles only. */
export function isSupportedAndroidDeviceProfile(
  profile: Pick<AndroidDeviceProfile, 'id' | 'name' | 'tag'>,
): boolean {
  return profile.tag === null && isPixelPhone(profile.id, profile.name);
}

/** Allow physical Android devices; classify AVDs from their profile metadata. */
export function isSupportedAndroidDevice(device: AndroidDevice): boolean {
  if (device.type === 'device') {
    return true;
  }

  const profile = device.config['hw.device.name'] ?? device.properties.Device;
  return isPixelPhone(profile ?? device.name);
}

function isIphoneDeviceTypeIdentifier(identifier: string | null): boolean {
  return identifier !== null && /(?:^|\.)iPhone(?:-|$)/i.test(identifier);
}

function isPixelPhone(...candidates: Array<string | undefined>): boolean {
  return candidates.some((candidate) => {
    if (!candidate) return false;
    const normalized = candidate.toLowerCase().replaceAll('_', ' ').replaceAll('-', ' ');
    return (
      /(?:^|\s)pixel(?:\s|$)/.test(normalized) &&
      !/(?:^|\s)(?:tablet|watch|buds|fold)(?:\s|$)/.test(normalized) &&
      !/(?:^|\s)pixel\s+c(?:\s|$)/.test(normalized)
    );
  });
}
