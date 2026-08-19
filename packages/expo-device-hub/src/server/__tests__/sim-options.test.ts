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
          models: [{ value: 'iPhone-16', label: 'iPhone 16', supported: true }],
        },
        {
          value: 'ios-17',
          label: 'iOS 17.0',
          models: [{ value: 'iPhone-16', label: 'iPhone 16', supported: true }],
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

  test('pairs mobile and specialized images with compatible profile tags', () => {
    const profiles: AndroidDeviceProfile[] = [
      { id: 'medium_phone', index: 0, name: 'Medium Phone', oem: 'Generic', tag: null },
      { id: 'tv_4k', index: 1, name: 'Television (4K)', oem: 'Google', tag: 'android-tv' },
      {
        id: 'wearos_square',
        index: 2,
        name: 'Wear OS Square',
        oem: 'Google',
        tag: 'android-wear',
      },
      {
        id: 'automotive_portrait',
        index: 3,
        name: 'Automotive Portrait',
        oem: 'Google',
        tag: 'android-automotive',
      },
    ];
    const images: AndroidSystemImage[] = [
      androidImage('android-36', null, 'arm64-v8a'),
      androidImage('android-35', 'google_apis_playstore', 'arm64-v8a'),
      androidImage('android-35', 'android-tv', 'arm64-v8a'),
      androidImage('android-35', 'android-wear', 'arm64-v8a'),
      androidImage('android-35', 'android-automotive-playstore', 'arm64-v8a'),
    ];

    const runtimes = androidImagesToOptions(images, profiles).runtimes;
    expect(modelsForTag(runtimes, null)).toEqual(['medium_phone']);
    expect(modelsForTag(runtimes, 'google_apis_playstore')).toEqual(['medium_phone']);
    expect(modelsForTag(runtimes, 'android-tv')).toEqual(['tv_4k']);
    expect(modelsForTag(runtimes, 'android-wear')).toEqual(['wearos_square']);
    expect(modelsForTag(runtimes, 'android-automotive-playstore')).toEqual([
      'automotive_portrait',
    ]);
  });
});

function modelsForTag(
  runtimes: ReturnType<typeof androidImagesToOptions>['runtimes'],
  tag: string | null
): string[] {
  return (
    runtimes
      .find((runtime) => runtime.value.includes(`;${tag ?? ''};`))
      ?.models.map((model) => model.value) ?? []
  );
}

function appleRuntime(overrides: Partial<AppleSimulatorRuntime> = {}): AppleSimulatorRuntime {
  return {
    identifier: 'ios-runtime',
    name: 'iOS 18.0',
    version: '18.0',
    buildVersion: null,
    platform: 'iOS',
    isAvailable: true,
    supportedDeviceTypes: [{ identifier: 'iPhone-16', name: 'iPhone 16', productFamily: 'iPhone' }],
    ...overrides,
  };
}

function androidImage(apiLevel: string, tag: string | null, abi: string): AndroidSystemImage {
  return {
    package: `system-images;${apiLevel};${tag ?? ''};${abi}`,
    apiLevel,
    tag,
    abi,
    version: '1',
    description: `${apiLevel} system image`,
    location: `system-images/${apiLevel}/${tag ?? ''}/${abi}`,
  };
}
