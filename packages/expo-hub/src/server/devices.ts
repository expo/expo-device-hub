/**
 * Device discovery for the Expo Hub DevTools server.
 *
 * iOS simulators are listed for real via `@expo-hub/apple-utils` (which shells
 * out to `devicectl`), filtered to those that are both *simulated* and *booted*.
 * Android emulators are still mocked here — they'll move to
 * `@expo-hub/android-utils` later, mirroring the iOS path.
 *
 * The returned shape mirrors `dashboard/data.ts`'s `Device`, so the DOM sidebar
 * can consume `/api/devices` directly.
 */

import { listDevices as listAppleDevices } from '@expo-hub/apple-utils';

export type HubDevicePlatform = 'ios' | 'android';

export interface HubDevice {
  /** udid (iOS) / serial (Android). */
  id: string;
  name: string;
  /** e.g. "iOS 27.0" / "Android 16". */
  version: string;
  platform: HubDevicePlatform;
}

export interface HubDeviceList {
  simulators: HubDevice[];
  emulators: HubDevice[];
}

/** Booted iOS simulators, via `@expo-hub/apple-utils` → `devicectl`. */
export async function listIosSimulators(): Promise<HubDevice[]> {
  const devices = await listAppleDevices();

  return devices
    .filter(
      (device) =>
        device.hardwareProperties?.reality === 'simulated' &&
        device.deviceProperties?.bootState === 'booted',
    )
    .map((device) => {
      const id = device.hardwareProperties?.udid ?? device.identifier ?? '';
      const name =
        device.deviceProperties?.name ?? device.hardwareProperties?.marketingName ?? 'Simulator';
      const platform = device.hardwareProperties?.platform ?? 'iOS';
      const osVersion = device.deviceProperties?.osVersionNumber;

      return {
        id,
        name,
        version: osVersion ? `${platform} ${osVersion}` : platform,
        platform: 'ios' as const,
      };
    });
}

/**
 * Android emulators. Mocked for now — to be replaced with
 * `@expo-hub/android-utils` later, the same way `listIosSimulators` uses
 * `@expo-hub/apple-utils`.
 */
export function listAndroidEmulators(): HubDevice[] {
  return [
    { id: 'pixel-9-pro', name: 'Pixel 9 Pro', version: 'Android 16', platform: 'android' },
    { id: 'pixel-9a', name: 'Pixel 9a', version: 'Android 15', platform: 'android' },
  ];
}

/** The full device list the dashboard sidebar renders. */
export async function listDevices(): Promise<HubDeviceList> {
  return {
    simulators: await listIosSimulators(),
    emulators: listAndroidEmulators(),
  };
}
