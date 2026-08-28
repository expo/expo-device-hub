import { type AndroidDevice, type AndroidDeviceProfile } from '@expo/hub-android-utils';
import { describe, expect, test } from 'bun:test';

import {
  androidDeviceFrame,
  androidDeviceProfileFrame,
  appleDeviceFrame,
  appleDeviceTypeFrame,
  isSupportedAndroidDevice,
  isSupportedAndroidDeviceProfile,
  isSupportedAppleDevice,
  isSupportedAppleDeviceType,
} from '../device-support';

describe('iOS device support', () => {
  test('keeps iPhone support independent from exact frame-profile availability', () => {
    const iphone17Pro = {
      identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
    };
    const iphone16Pro = {
      identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
    };
    const ipad = { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4' };

    expect(isSupportedAppleDeviceType(iphone17Pro)).toBe(true);
    expect(appleDeviceTypeFrame(iphone17Pro)).toBe('ios:iphone-17-pro');
    expect(isSupportedAppleDeviceType(iphone16Pro)).toBe(true);
    expect(appleDeviceTypeFrame(iphone16Pro)).toBeNull();
    expect(isSupportedAppleDeviceType(ipad)).toBe(false);
    expect(appleDeviceTypeFrame(ipad)).toBeNull();
  });

  test('classifies existing simulators from their device type identifier', () => {
    expect(
      isSupportedAppleDevice({
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      }),
    ).toBe(true);
    expect(
      appleDeviceFrame({
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      }),
    ).toBe('ios:iphone-17-pro');
    expect(
      isSupportedAppleDevice({
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
      }),
    ).toBe(true);
    expect(
      appleDeviceFrame({
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
      }),
    ).toBeNull();
    expect(
      isSupportedAppleDevice({
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4',
      }),
    ).toBe(false);
    expect(isSupportedAppleDevice({ deviceTypeIdentifier: null })).toBe(false);
    expect(appleDeviceFrame({ deviceTypeIdentifier: null })).toBeNull();
  });
});

describe('Android device support', () => {
  test('keeps Pixel-phone support independent from exact frame-profile availability', () => {
    expect(isSupportedAndroidDeviceProfile(profile('pixel_10_pro', 'Pixel 10 Pro'))).toBe(true);
    expect(androidDeviceProfileFrame(profile('pixel_10_pro', 'Pixel 10 Pro'))).toBe(
      'android:pixel-10-pro',
    );
    expect(androidDeviceProfileFrame(profile('pixel_6', 'Pixel 6'))).toBe(
      'android:pixel-10-pro',
    );
    expect(isSupportedAndroidDeviceProfile(profile('pixel_9', 'Pixel 9'))).toBe(true);
    expect(androidDeviceProfileFrame(profile('pixel_9', 'Pixel 9'))).toBeNull();
    expect(isSupportedAndroidDeviceProfile(profile('pixel_9_pro_fold', 'Pixel 9 Pro Fold'))).toBe(
      false,
    );
    expect(androidDeviceProfileFrame(profile('pixel_9_pro_fold', 'Pixel 9 Pro Fold'))).toBeNull();
    expect(isSupportedAndroidDeviceProfile(profile('pixel_fold', 'Pixel Fold'))).toBe(false);
    expect(isSupportedAndroidDeviceProfile(profile('pixel_tablet', 'Pixel Tablet'))).toBe(false);
    expect(isSupportedAndroidDeviceProfile(profile('pixel_c', 'Pixel C'))).toBe(false);
    expect(isSupportedAndroidDeviceProfile(profile('medium_phone', 'Medium Phone'))).toBe(false);
    expect(
      isSupportedAndroidDeviceProfile(profile('pixel_watch', 'Pixel Watch', 'android-wear')),
    ).toBe(false);
    expect(
      androidDeviceProfileFrame(profile('pixel_watch', 'Pixel Watch', 'android-wear')),
    ).toBeNull();
    expect(isSupportedAndroidDeviceProfile(profile('pixel_buds', 'Pixel Buds'))).toBe(false);
    expect(androidDeviceProfileFrame(profile('medium_phone', 'Medium Phone'))).toBeNull();
  });

  test('classifies known AVDs from their profile metadata', () => {
    expect(
      isSupportedAndroidDevice(androidDevice({ config: { 'hw.device.name': 'pixel_10_pro' } })),
    ).toBe(true);
    expect(
      androidDeviceFrame(androidDevice({ config: { 'hw.device.name': 'pixel_10_pro' } })),
    ).toBe('android:pixel-10-pro');
    expect(androidDeviceFrame(androidDevice({ config: { 'hw.device.name': 'pixel_6' } }))).toBe(
      'android:pixel-10-pro',
    );
    expect(androidDeviceFrame(androidDevice({ config: { 'hw.device.name': 'pixel_8' } }))).toBeNull();
    expect(
      isSupportedAndroidDevice(
        androidDevice({
          name: 'Pixel_9',
          properties: { Device: 'medium_phone (Generic)' },
        }),
      ),
    ).toBe(false);
    expect(
      androidDeviceFrame(
        androidDevice({
          name: 'Pixel_9',
          properties: { Device: 'medium_phone (Generic)' },
        }),
      ),
    ).toBeNull();
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
    expect(
      androidDeviceFrame(
        androidDevice({ type: 'device', properties: { 'ro.product.model': 'Pixel 10 Pro' } }),
      ),
    ).toBe('android:pixel-10-pro');
    expect(
      androidDeviceFrame(
        androidDevice({ type: 'device', properties: { 'ro.product.model': 'Pixel 9 Pro' } }),
      ),
    ).toBeNull();
    expect(
      androidDeviceFrame(
        androidDevice({ type: 'device', properties: { 'ro.product.model': 'Galaxy S25' } }),
      ),
    ).toBeNull();
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
