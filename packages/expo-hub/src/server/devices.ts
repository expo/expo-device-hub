/**
 * Device discovery for the Expo Hub DevTools server.
 *
 * iOS simulators are listed via `@expo-hub/apple-utils` (which shells out to
 * `devicectl`), filtered to those that are *simulated* — both booted and
 * shut-down. Android devices are listed via `@expo-hub/android-utils` (which
 * shells out to `avdmanager` / `adb`): every known AVD plus any connected
 * physical device. Each device carries a `booted` flag, so the caller can show
 * the running devices in the sidebar and offer the rest as "recent" devices to
 * add (see `/api/devices?booted=true` in `index.ts`).
 *
 * The returned shape mirrors `dashboard/data.ts`'s `Device`, so the DOM sidebar
 * can consume `/api/devices` directly.
 */

import { type AndroidDevice, listDevices as listAndroidDevices } from '@expo-hub/android-utils';
import { listDevices as listAppleDevices } from '@expo-hub/apple-utils';

export type HubDevicePlatform = 'ios' | 'android';

export interface HubDevice {
  /** udid (iOS) / serial-or-AVD-name (Android). */
  id: string;
  name: string;
  /** e.g. "iOS 27.0" / "Android 16". */
  version: string;
  platform: HubDevicePlatform;
  /** Whether the device is currently booted / running. */
  booted: boolean;
}

export interface HubDeviceList {
  simulators: HubDevice[];
  emulators: HubDevice[];
}

/** All iOS simulators (booted and shut-down), via `@expo-hub/apple-utils` → `devicectl`. */
export async function listIosSimulators(): Promise<HubDevice[]> {
  const devices = await listAppleDevices();

  return devices
    .filter((device) => device.hardwareProperties?.reality === 'simulated')
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
        booted: device.deviceProperties?.bootState === 'booted',
      };
    });
}

/**
 * All Android devices — every AVD plus connected physical devices — via
 * `@expo-hub/android-utils` → `avdmanager` / `adb`. Shut-down AVDs are included
 * (with `booted: false`) so they can be offered as recent devices.
 */
export async function listAndroidEmulators(): Promise<HubDevice[]> {
  const devices = await listAndroidDevices();

  return devices.map((device) => ({
    id: device.serial ?? device.name,
    name: device.name,
    version: androidVersion(device),
    platform: 'android' as const,
    booted: device.booted,
  }));
}

/** Derive an "Android <version>" label from a device's getprop / avdmanager fields. */
function androidVersion(device: AndroidDevice): string {
  const release = device.properties['ro.build.version.release'];
  // Normalize a bare major version to one decimal place: "17" → "17.0", while
  // "17.2" is left untouched.
  if (release) return `Android ${/^\d+$/.test(release) ? `${release}.0` : release}`;

  const match = /Android\s+[\d.]+/.exec(device.properties['Based on'] ?? '');
  return match ? match[0] : 'Android';
}

/** Every known simulator and emulator/device, each tagged with its `booted` state. */
export async function listDevices(): Promise<HubDeviceList> {
  const [simulators, emulators] = await Promise.all([
    listIosSimulators(),
    listAndroidEmulators(),
  ]);

  return { simulators, emulators };
}
