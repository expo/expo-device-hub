import { type AndroidDeviceProfile, type AndroidSystemImage } from '@expo/hub-android-utils';
import { type AppleSimulatorRuntime } from '@expo/hub-apple-utils';
import { describe, expect, test } from 'bun:test';

import { androidImagesToOptions, appleRuntimesToOptions } from '../sim-options';

describe('appleRuntimesToOptions', () => {
  test('keeps available iOS runtimes with their compatible device types', () => {
    const result = appleRuntimesToOptions([
      appleRuntime({ identifier: 'ios-17', name: 'iOS 17.0', version: '17.0' }),
      appleRuntime({ identifier: 'ios-18', name: 'iOS 18.0', version: '18.0' }),
      appleRuntime({ identifier: 'unavailable', isAvailable: false }),
      appleRuntime({ identifier: 'tvos', platform: 'tvOS' }),
    ]);

    expect(result).toEqual({
      runtimes: [
        {
          value: 'ios-18',
          label: 'iOS 18.0',
          models: [{ value: 'iphone-16', label: 'iPhone 16', supported: true }],
        },
        {
          value: 'ios-17',
          label: 'iOS 17.0',
          models: [{ value: 'iphone-16', label: 'iPhone 16', supported: true }],
        },
      ],
    });
  });
});

describe('androidImagesToOptions', () => {
  test('pairs installed images with sorted device profiles', () => {
    const profiles: AndroidDeviceProfile[] = [
      { id: 'pixel_9', index: 1, name: 'Pixel 9', oem: 'Google', tag: null },
      { id: 'pixel_8', index: 0, name: 'Pixel 8', oem: 'Google', tag: null },
    ];
    const images: AndroidSystemImage[] = [
      androidImage('android-34', 'google_apis', 'arm64-v8a'),
      androidImage('android-35', 'google_apis_playstore', 'arm64-v8a'),
    ];

    expect(androidImagesToOptions(images, profiles)).toEqual({
      runtimes: [
        {
          value: 'system-images;android-35;google_apis_playstore;arm64-v8a',
          label: 'Android 35 · Google Play · arm64-v8a',
          models: [
            { value: 'pixel_8', label: 'Pixel 8', supported: true },
            { value: 'pixel_9', label: 'Pixel 9', supported: true },
          ],
        },
        {
          value: 'system-images;android-34;google_apis;arm64-v8a',
          label: 'Android 34 · Google APIs · arm64-v8a',
          models: [
            { value: 'pixel_8', label: 'Pixel 8', supported: true },
            { value: 'pixel_9', label: 'Pixel 9', supported: true },
          ],
        },
      ],
    });
  });
});

function appleRuntime(overrides: Partial<AppleSimulatorRuntime> = {}): AppleSimulatorRuntime {
  return {
    identifier: 'ios-runtime',
    name: 'iOS 18.0',
    version: '18.0',
    buildVersion: null,
    platform: 'iOS',
    isAvailable: true,
    supportedDeviceTypes: [{ identifier: 'iphone-16', name: 'iPhone 16', productFamily: 'iPhone' }],
    ...overrides,
  };
}

function androidImage(apiLevel: string, tag: string, abi: string): AndroidSystemImage {
  return {
    package: `system-images;${apiLevel};${tag};${abi}`,
    apiLevel,
    tag,
    abi,
    version: '1',
    description: `${apiLevel} system image`,
    location: `system-images/${apiLevel}/${tag}/${abi}`,
  };
}
