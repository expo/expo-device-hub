import { type AndroidDevice, type AndroidDeviceProfile } from '@expo/hub-android-utils';
import { type AppleDevice, type AppleSimulatorDeviceType } from '@expo/hub-apple-utils';
import { type DeviceFrameProfileId } from '@expo/hub-components';

const IPHONE_17_PRO_DEVICE_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';
const IPHONE_17_PRO_FRAME = 'ios:iphone-17-pro';
const PIXEL_10_PRO_FRAME = 'android:pixel-10-pro';

export function appleDeviceTypeFrame(
  deviceType: Pick<AppleSimulatorDeviceType, 'identifier'>,
): DeviceFrameProfileId | null {
  return deviceType.identifier === IPHONE_17_PRO_DEVICE_TYPE ? IPHONE_17_PRO_FRAME : null;
}

export function appleDeviceFrame(
  device: Pick<AppleDevice, 'deviceTypeIdentifier'>,
): DeviceFrameProfileId | null {
  return device.deviceTypeIdentifier === IPHONE_17_PRO_DEVICE_TYPE ? IPHONE_17_PRO_FRAME : null;
}

export function androidDeviceProfileFrame(
  profile: Pick<AndroidDeviceProfile, 'id' | 'name' | 'tag'>,
): DeviceFrameProfileId | null {
  return usesPixel10ProFrame(profile.id, profile.name) ? PIXEL_10_PRO_FRAME : null;
}

export function androidDeviceFrame(device: AndroidDevice): DeviceFrameProfileId | null {
  const profile =
    device.type === 'device'
      ? (device.properties['ro.product.model'] ?? device.name)
      : (device.config['hw.device.name'] ?? device.properties.Device);
  return usesPixel10ProFrame(profile ?? device.name) ? PIXEL_10_PRO_FRAME : null;
}

/** Hub currently supports and tests iPhone simulator hardware only. */
export function isSupportedAppleDeviceType(
  deviceType: Pick<AppleSimulatorDeviceType, 'identifier'>,
): boolean {
  return isIphoneDeviceTypeIdentifier(deviceType.identifier);
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
  return identifier?.includes('iPhone') ?? false;
}

function isPixelPhone(...candidates: Array<string | undefined>): boolean {
  return candidates.some((candidate) => {
    if (!candidate) return false;
    const normalized = candidate.toLowerCase().replaceAll('_', ' ').replaceAll('-', ' ');
    return /pixel/.test(normalized) && !/(?:fold|tablet|watch|buds|pixel c)/.test(normalized);
  });
}

function usesPixel10ProFrame(...candidates: Array<string | undefined>): boolean {
  return candidates.some((candidate) => {
    const name = normalizeDeviceName(candidate);
    // Temporary preview mapping until the Pixel 6 has its own calibrated frame.
    return name === 'pixel 10 pro' || name === 'pixel 6';
  });
}

function normalizeDeviceName(candidate: string | undefined): string | null {
  return candidate?.toLowerCase().replaceAll('_', ' ').replaceAll('-', ' ').trim() ?? null;
}
