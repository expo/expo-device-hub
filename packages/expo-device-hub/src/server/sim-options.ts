/** Host toolchain options used by the new simulator/emulator picker. */

import {
  type AndroidDeviceProfile,
  type AndroidSystemImage,
  listDeviceProfiles,
  listSystemImages,
} from '@expo/hub-android-utils';
import { type AppleSimulatorRuntime, listRuntimes } from '@expo/hub-apple-utils';
import { type NewDeviceOptions, type Platform } from '@expo/hub-components';

import { type PlatformFilter } from '../platform-filter';
import {
  androidDeviceProfileFrame,
  appleDeviceTypeFrame,
  isSupportedAndroidDeviceProfile,
  isSupportedAppleDeviceType,
} from './device-support';
import { type SerializableError, toSerializableError } from './utility-errors';

export type NewDeviceOptionsByPlatform = Record<Platform, NewDeviceOptions>;
export type NewDeviceOptionsResponse = NewDeviceOptionsByPlatform & { errors: SerializableError[] };

const EMPTY_OPTIONS: NewDeviceOptions = { runtimes: [] };

/** Discover installed runtimes and profiles for the requested platform(s). */
export async function listNewDeviceOptions(
  platform?: PlatformFilter
): Promise<NewDeviceOptionsResponse> {
  if (platform === 'ios') {
    const appleRuntimes = await listRuntimes();
    return {
      ios: appleRuntimesToOptions(appleRuntimes.value),
      android: EMPTY_OPTIONS,
      errors: [toSerializableError(appleRuntimes.error)].filter(
        (error): error is SerializableError => error !== null
      ),
    };
  }

  if (platform === 'android') {
    const [androidImages, androidProfiles] = await Promise.all([
      listSystemImages(),
      listDeviceProfiles(),
    ]);
    return {
      ios: EMPTY_OPTIONS,
      android: androidImagesToOptions(androidImages.value, androidProfiles.value),
      errors: [
        toSerializableError(androidImages.error),
        toSerializableError(androidProfiles.error),
      ].filter((error): error is SerializableError => error !== null),
    };
  }

  const [appleRuntimes, androidImages, androidProfiles] = await Promise.all([
    listRuntimes(),
    listSystemImages(),
    listDeviceProfiles(),
  ]);

  return {
    ios: appleRuntimesToOptions(appleRuntimes.value),
    android: androidImagesToOptions(androidImages.value, androidProfiles.value),
    errors: [
      toSerializableError(appleRuntimes.error),
      toSerializableError(androidImages.error),
      toSerializableError(androidProfiles.error),
    ].filter((error): error is SerializableError => error !== null),
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
          supported: isSupportedAppleDeviceType(deviceType),
          deviceFrame: appleDeviceTypeFrame(deviceType),
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
    .map((profile) => ({
      profile,
      value: profile.id,
      label: profile.name || profile.id,
      supported: isSupportedAndroidDeviceProfile(profile),
      deviceFrame: androidDeviceProfileFrame(profile),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

  return {
    runtimes: images
      .map((image) => ({
        value: image.package,
        label: androidImageLabel(image),
        models: models
          .filter(({ profile }) => isAndroidProfileCompatibleWithImage(profile, image))
          .map(({ profile: _profile, ...model }) => model),
      }))
      .filter((runtime) => runtime.models.length > 0)
      .sort((a, b) => compareVersionsDescending(a.label, b.label)),
  };
}

const MOBILE_SYSTEM_IMAGE_TAG_PREFIXES = ['default', 'google_apis'];

function isAndroidProfileCompatibleWithImage(
  profile: AndroidDeviceProfile,
  image: AndroidSystemImage
): boolean {
  if (profile.tag === null) {
    if (image.tag === null) return true;
    return MOBILE_SYSTEM_IMAGE_TAG_PREFIXES.some((prefix) => image.tag?.startsWith(prefix));
  }

  if (image.tag === null) return false;
  return profile.tag.startsWith(image.tag) || image.tag.startsWith(profile.tag);
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
