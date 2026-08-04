/** Host toolchain options used by the new simulator/emulator picker. */

import {
  type AndroidDeviceProfile,
  type AndroidSystemImage,
  listDeviceProfiles,
  listSystemImages,
} from '@expo/hub-android-utils';
import { type AppleSimulatorRuntime, listRuntimes } from '@expo/hub-apple-utils';
import { type NewDeviceOptions, type Platform } from '@expo/hub-components';

export type NewDeviceOptionsByPlatform = Record<Platform, NewDeviceOptions>;

/** Discover installed iOS runtimes and Android images/profiles in parallel. */
export async function listNewDeviceOptions(): Promise<NewDeviceOptionsByPlatform> {
  const [appleRuntimes, androidImages, androidProfiles] = await Promise.all([
    listRuntimes(),
    listSystemImages(),
    listDeviceProfiles(),
  ]);

  return {
    ios: appleRuntimesToOptions(appleRuntimes),
    android: androidImagesToOptions(androidImages, androidProfiles),
  };
}

/** Keep available iOS runtimes and the simulator models each runtime supports. */
export function appleRuntimesToOptions(runtimes: AppleSimulatorRuntime[]): NewDeviceOptions {
  return {
    runtimes: runtimes
      .filter((runtime) => runtime.isAvailable && runtime.platform === 'iOS')
      .map((runtime) => ({
        value: runtime.identifier,
        label: runtime.name || `iOS ${runtime.version}`,
        models: runtime.supportedDeviceTypes.map((deviceType) => ({
          value: deviceType.identifier,
          label: deviceType.name,
        })),
      }))
      .filter((runtime) => runtime.models.length > 0)
      .sort((a, b) => compareVersionsDescending(a.label, b.label)),
  };
}

/** Pair every installed Android system image with the SDK's device profiles. */
export function androidImagesToOptions(
  images: AndroidSystemImage[],
  profiles: AndroidDeviceProfile[]
): NewDeviceOptions {
  const models = profiles
    .map((profile) => ({ value: profile.id, label: profile.name || profile.id }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

  return {
    runtimes: images
      .map((image) => ({
        value: image.package,
        label: androidImageLabel(image),
        models,
      }))
      .filter((runtime) => runtime.models.length > 0)
      .sort((a, b) => compareVersionsDescending(a.label, b.label)),
  };
}

function androidImageLabel(image: AndroidSystemImage): string {
  const api = image.apiLevel?.replace(/^android-/i, 'Android ') ?? image.description;
  const tag =
    image.tag === 'google_apis'
      ? 'Google APIs'
      : image.tag === 'google_apis_playstore'
        ? 'Google Play'
        : image.tag === 'default'
          ? 'AOSP'
          : image.tag?.replaceAll('_', ' ');
  return [api, tag, image.abi].filter(Boolean).join(' · ');
}

function compareVersionsDescending(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
}
