import { type AndroidDevice, type AndroidDeviceProfile } from '@expo/hub-android-utils';
import { describe, expect, test } from 'bun:test';

import {
  isSupportedAndroidDevice,
  isSupportedAndroidDeviceProfile,
  isSupportedAppleDevice,
  isSupportedAppleDeviceType,
} from '../device-support';

describe('iOS device support', () => {
  test('supports iPhone simulator types and rejects other Apple families', () => {
    expect(isSupportedAppleDeviceType({ productFamily: 'iPhone' })).toBe(true);
    expect(isSupportedAppleDeviceType({ productFamily: 'iPad' })).toBe(false);
    expect(isSupportedAppleDeviceType({ productFamily: null })).toBe(false);
  });

  test('classifies existing simulators from their device type identifier', () => {
    expect(
      isSupportedAppleDevice({
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
      }),
    ).toBe(true);
    expect(
      isSupportedAppleDevice({
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4',
      }),
    ).toBe(false);
    expect(isSupportedAppleDevice({ deviceTypeIdentifier: null })).toBe(false);
  });
});

describe('Android device support', () => {
  test('supports Pixel phone profiles and rejects other or non-phone profiles', () => {
    expect(isSupportedAndroidDeviceProfile(profile('pixel_9', 'Pixel 9'))).toBe(true);
    expect(isSupportedAndroidDeviceProfile(profile('pixel_9_pro_fold', 'Pixel 9 Pro Fold'))).toBe(
      false,
    );
    expect(isSupportedAndroidDeviceProfile(profile('pixel_fold', 'Pixel Fold'))).toBe(false);
    expect(isSupportedAndroidDeviceProfile(profile('pixel_tablet', 'Pixel Tablet'))).toBe(false);
    expect(isSupportedAndroidDeviceProfile(profile('medium_phone', 'Medium Phone'))).toBe(false);
    expect(
      isSupportedAndroidDeviceProfile(profile('pixel_watch', 'Pixel Watch', 'android-wear')),
    ).toBe(false);
  });

  test('classifies known AVDs from their profile metadata', () => {
    expect(
      isSupportedAndroidDevice(androidDevice({ config: { 'hw.device.name': 'pixel_8' } })),
    ).toBe(true);
    expect(
      isSupportedAndroidDevice(
        androidDevice({
          name: 'Pixel_9',
          properties: { Device: 'medium_phone (Generic)' },
        }),
      ),
    ).toBe(false);
  });

  test('supports all physical Android devices', () => {
    expect(
      isSupportedAndroidDevice(
        androidDevice({ type: 'device', properties: { 'ro.product.model': 'Pixel 9 Pro' } }),
      ),
    ).toBe(true);
    expect(
      isSupportedAndroidDevice(
        androidDevice({ type: 'device', properties: { 'ro.product.model': 'Galaxy S25' } }),
      ),
    ).toBe(true);
    expect(isSupportedAndroidDevice(androidDevice({ type: 'device' }))).toBe(true);
  });

  test('treats unknown Android emulators as untested', () => {
    expect(isSupportedAndroidDevice(androidDevice())).toBe(false);
  });
});

function profile(id: string, name: string, tag: string | null = null): AndroidDeviceProfile {
  return { id, name, tag, index: null, oem: null };
}

function androidDevice(overrides: Partial<AndroidDevice> = {}): AndroidDevice {
  return {
    name: 'Test_Device',
    type: 'emulator',
    booted: true,
    serial: 'emulator-5554',
    path: null,
    lastBootedAt: null,
    properties: {},
    config: {},
    ...overrides,
  };
}
