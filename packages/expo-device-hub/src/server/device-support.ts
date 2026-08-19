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

/** Hub currently supports and tests non-folding Google Pixel emulator profiles only. */
export function isSupportedAndroidDeviceProfile(
  profile: Pick<AndroidDeviceProfile, 'name'>,
): boolean {
  return isSupportedPixelName(profile.name);
}

/** Allow physical Android devices; classify AVDs from their profile metadata. */
export function isSupportedAndroidDevice(device: AndroidDevice): boolean {
  if (device.type === 'device') {
    return true;
  }

  const profile = device.config['hw.device.name'] ?? device.properties.Device;
  return isSupportedPixelName(profile ?? device.name);
}

function isIphoneDeviceTypeIdentifier(identifier: string | null): boolean {
  return identifier !== null && /(?:^|\.)iPhone(?:-|$)/i.test(identifier);
}

function isSupportedPixelName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.includes('pixel') && !normalized.includes('fold');
}
