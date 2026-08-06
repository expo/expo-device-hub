/**
 * Device discovery for the Expo Hub DevTools server.
 *
 * iOS simulators are listed via `@expo/hub-apple-utils` (which shells out to
 * `simctl`) when CoreSimulator has usage history for them — both booted and
 * shut-down. Android devices are listed via
 * `@expo/hub-android-utils` (which shells out to `avdmanager` / `adb`): every
 * known AVD plus any connected physical device. Each device carries a `booted`
 * flag, so the caller can show the running devices in the sidebar and offer the
 * rest as "recent" devices to add (see `/api/devices?booted=true` in `index.ts`).
 *
 * The returned shape mirrors `@expo/hub-components`'s `Device` type, so the DOM
 * sidebar can consume `/api/devices` directly.
 */

import { type AndroidDevice, listDevices as listAndroidDevices } from '@expo/hub-android-utils';
import { listDevices as listAppleDevices } from '@expo/hub-apple-utils';

import { type SerializableError, toSerializableError } from './utility-errors';

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
  /**
   * Whether this is real physical hardware rather than a simulator/emulator.
   * Physical devices can't be removed from Hub, so the UI hides that action.
   */
  physical: boolean;
  /**
   * Epoch ms the device was last used — drives the "Recents" relative time
   * ("18m ago", "2 days ago") in the add-device picker. For iOS this is the
   * newest `lastUsedAt` / `lastBootedAt` value from CoreSimulator's
   * device.plist. It is absent when the platform does not provide usage data.
   */
  lastUsedAt?: number;
}

export interface HubDeviceList {
  simulators: HubDevice[];
  emulators: HubDevice[];
  /** Utility failures captured during this discovery pass. */
  errors?: SerializableError[];
}

interface PlatformDeviceList {
  devices: HubDevice[];
  error: SerializableError | null;
}

/** Available iOS simulators with plist usage history, via `@expo/hub-apple-utils` → `simctl`. */
export async function listIosSimulators(): Promise<PlatformDeviceList> {
  const listed = await listAppleDevices();

  return {
    devices: listed.value
      .filter((device) => device.platform === 'iOS' && device.isAvailable)
      .map((device) => {
        const platform = device.platform ?? 'iOS';

        return {
          id: device.udid,
          name: device.name || 'Simulator',
          version: device.osVersion ? `${platform} ${device.osVersion}` : platform,
          platform: 'ios' as const,
          booted: device.state.toLowerCase() === 'booted',
          physical: false,
          lastUsedAt: latestTimestamp(device.lastUsedAt, device.lastBootedAt),
        };
      })
      .filter((device) => device.lastUsedAt !== undefined),
    error: toSerializableError(listed.error),
  };
}

/**
 * All Android devices — every AVD plus connected physical devices — via
 * `@expo/hub-android-utils` → `avdmanager` / `adb`. Shut-down AVDs are included
 * (with `booted: false`) so they can be offered as recent devices.
 */
export async function listAndroidEmulators(): Promise<PlatformDeviceList> {
  const listed = await listAndroidDevices();

  return {
    devices: listed.value.map((device) => ({
      id: device.serial ?? device.name,
      name: device.name,
      version: androidVersion(device),
      platform: 'android' as const,
      booted: device.booted,
      physical: device.type === 'device',
    })),
    error: toSerializableError(listed.error),
  };
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

function latestTimestamp(...timestamps: Array<number | null>): number | undefined {
  const available = timestamps.filter((timestamp): timestamp is number => timestamp !== null);
  return available.length > 0 ? Math.max(...available) : undefined;
}

/** Every known simulator and emulator/device, each tagged with its `booted` state. */
export async function listDevices(): Promise<HubDeviceList> {
  const [simulators, emulators] = await Promise.all([listIosSimulators(), listAndroidEmulators()]);

  return {
    simulators: simulators.devices,
    emulators: emulators.devices,
    errors: [simulators.error, emulators.error].filter(
      (error): error is SerializableError => error !== null
    ),
  };
}
