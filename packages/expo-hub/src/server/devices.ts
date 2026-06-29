/**
 * Device discovery for the Expo Hub DevTools server.
 *
 * iOS simulators are listed via `@expo/hub-apple-utils` (which shells out to
 * `devicectl`), filtered to those that are *simulated* — both booted and
 * shut-down. Android devices are listed via `@expo/hub-android-utils` (which
 * shells out to `avdmanager` / `adb`): every known AVD plus any connected
 * physical device. Each device carries a `booted` flag, so the caller can show
 * the running devices in the sidebar and offer the rest as "recent" devices to
 * add (see `/api/devices?booted=true` in `index.ts`).
 *
 * The returned shape mirrors `@expo/hub-components`'s `Device` type, so the DOM
 * sidebar can consume `/api/devices` directly.
 */

import { type AndroidDevice, listDevices as listAndroidDevices } from '@expo/hub-android-utils';
import { listDevices as listAppleDevices } from '@expo/hub-apple-utils';

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
   * Physical devices can't be erased/wiped from Hub, so the UI hides that action.
   */
  physical: boolean;
  /**
   * Epoch ms the device was last used — drives the "Recents" relative time
   * ("18m ago", "2 days ago") in the add-device picker. MOCKED for now: neither
   * `devicectl` nor `adb` reports a last-used timestamp, so we synthesize a
   * plausible spread (see `withMockLastUsed`). Replace with a real signal (e.g.
   * a persisted usage log) when one exists.
   */
  lastUsedAt?: number;
}

export interface HubDeviceList {
  simulators: HubDevice[];
  emulators: HubDevice[];
}

/** All iOS simulators (booted and shut-down), via `@expo/hub-apple-utils` → `devicectl`. */
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
        physical: device.hardwareProperties?.reality === 'physical',
      };
    });
}

/**
 * All Android devices — every AVD plus connected physical devices — via
 * `@expo/hub-android-utils` → `avdmanager` / `adb`. Shut-down AVDs are included
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
    physical: device.type === 'device',
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

/**
 * Mock "last used" offsets (ms before now) handed out, in order, to the
 * shut-down devices in a list — so the picker shows a realistic spread of
 * "18m ago / 1h ago / 2 days ago / 1 week ago" instead of every row reading the
 * same. Booted devices are stamped with "now" instead. Remove once a real
 * last-used signal exists.
 */
const MOCK_LAST_USED_OFFSETS_MS = [
  18 * 60_000, // 18m ago
  60 * 60_000, // 1h ago
  2 * 24 * 60 * 60_000, // 2 days ago
  7 * 24 * 60 * 60_000, // 1 week ago
  3 * 60 * 60_000, // 3h ago
  5 * 24 * 60 * 60_000, // 5 days ago
];

/** Stamp each device with a mock `lastUsedAt` (booted → now, others staggered). */
function withMockLastUsed(devices: HubDevice[]): HubDevice[] {
  const now = Date.now();
  let shutDownIndex = 0;
  return devices.map((device) => {
    if (device.booted) return { ...device, lastUsedAt: now };
    const offset =
      MOCK_LAST_USED_OFFSETS_MS[shutDownIndex++ % MOCK_LAST_USED_OFFSETS_MS.length];
    return { ...device, lastUsedAt: now - offset };
  });
}

/** Every known simulator and emulator/device, each tagged with its `booted` state. */
export async function listDevices(): Promise<HubDeviceList> {
  const [simulators, emulators] = await Promise.all([
    listIosSimulators(),
    listAndroidEmulators(),
  ]);

  return {
    simulators: withMockLastUsed(simulators),
    emulators: withMockLastUsed(emulators),
  };
}
