/**
 * Device discovery for the Expo Hub DevTools server.
 *
 * iOS simulators are listed for real via `@expo-hub/apple-utils` (which shells
 * out to `devicectl`), filtered to those that are both *simulated* and *booted*.
 * Android devices are listed via `@expo-hub/android-utils` (which shells out to
 * `avdmanager` / `adb`), filtered to those currently *booted* — booted emulators
 * plus connected physical devices.
 *
 * The returned shape mirrors `dashboard/data.ts`'s `Device`, so the DOM sidebar
 * can consume `/api/devices` directly.
 */

import { type AndroidDevice, listDevices as listAndroidDevices } from '@expo-hub/android-utils';
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
 * Booted Android devices — emulators and connected physical devices — via
 * `@expo-hub/android-utils` → `avdmanager` / `adb`.
 */
export async function listAndroidEmulators(): Promise<HubDevice[]> {
  const devices = await listAndroidDevices();

  return devices
    .filter((device) => device.booted)
    .map((device) => ({
      id: device.serial ?? device.name,
      name: device.name,
      version: androidVersion(device),
      platform: 'android' as const,
    }));
}

/** Derive an "Android <version>" label from a device's getprop / avdmanager fields. */
function androidVersion(device: AndroidDevice): string {
  const release = device.properties['ro.build.version.release'];
  if (release) return `Android ${release}`;

  const match = /Android\s+[\d.]+/.exec(device.properties['Based on'] ?? '');
  return match ? match[0] : 'Android';
}

/** The full device list the dashboard sidebar renders. */
export async function listDevices(): Promise<HubDeviceList> {
  const [simulators, emulators] = await Promise.all([
    listIosSimulators(),
    listAndroidEmulators(),
  ]);

  return { simulators, emulators };
}
