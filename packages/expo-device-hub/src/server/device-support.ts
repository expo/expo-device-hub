import { type AndroidDevice, type AndroidDeviceProfile } from '@expo/hub-android-utils';
import { type AppleDevice, type AppleSimulatorDeviceType } from '@expo/hub-apple-utils';
import { type DeviceFrameKind } from '@expo/hub-components';

export function appleDeviceTypeFrame(
  deviceType: Pick<AppleSimulatorDeviceType, 'identifier'>,
): DeviceFrameKind | null {
  return isIphoneDeviceTypeIdentifier(deviceType.identifier) ? 'iphone' : null;
}

export function appleDeviceFrame(
  device: Pick<AppleDevice, 'deviceTypeIdentifier'>,
): DeviceFrameKind | null {
  return isIphoneDeviceTypeIdentifier(device.deviceTypeIdentifier) ? 'iphone' : null;
}

export function androidDeviceProfileFrame(
  profile: Pick<AndroidDeviceProfile, 'id' | 'name' | 'tag'>,
): DeviceFrameKind | null {
  return isPixelDevice(profile.id, profile.name) ? 'pixel' : null;
}

export function androidDeviceFrame(device: AndroidDevice): DeviceFrameKind | null {
  const profile =
    device.type === 'device'
      ? (device.properties['ro.product.model'] ?? device.name)
      : (device.config['hw.device.name'] ?? device.properties.Device);
  return isPixelDevice(profile ?? device.name) ? 'pixel' : null;
}

/** Hub currently supports and tests iPhone simulator hardware only. */
export function isSupportedAppleDeviceType(
  deviceType: Pick<AppleSimulatorDeviceType, 'identifier'>,
): boolean {
  return appleDeviceTypeFrame(deviceType) !== null;
}

/** Classify an existing simulator from the device-type identifier reported by simctl. */
export function isSupportedAppleDevice(device: Pick<AppleDevice, 'deviceTypeIdentifier'>): boolean {
  return appleDeviceFrame(device) !== null;
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
  return identifier?.includes('iPhone') ?? false;
}

function isPixelPhone(...candidates: Array<string | undefined>): boolean {
  return candidates.some((candidate) => {
    if (!candidate) return false;
    const normalized = candidate.toLowerCase().replaceAll('_', ' ').replaceAll('-', ' ');
    return /pixel/.test(normalized) && !/(?:fold|tablet|watch|buds|pixel c)/.test(normalized);
  });
}

function isPixelDevice(...candidates: Array<string | undefined>): boolean {
  return candidates.some((candidate) => {
    if (!candidate) return false;
    const normalized = candidate.toLowerCase().replaceAll('_', ' ').replaceAll('-', ' ');
    return /pixel/.test(normalized);
  });
}
