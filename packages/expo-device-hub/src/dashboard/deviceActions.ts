import { type Device } from '@expo/hub-components';

/**
 * Device lifecycle actions, posted to the Hub DevTools plugin server (see
 * `src/server/device-actions.ts`). Expo CLI mounts the plugin under
 * `/_expo/plugins/expo-device-hub/*` and strips that prefix before calling the
 * handler, so from the browser these are the prefixed paths below.
 *
 * Each resolves to whether the server reported success and never throws — the
 * dashboard just refreshes its list afterward regardless.
 */
const SHUTDOWN_ENDPOINT = '/_expo/plugins/expo-device-hub/api/devices/shutdown';
const REMOVE_ENDPOINT = '/_expo/plugins/expo-device-hub/api/devices/remove';
const BOOT_ENDPOINT = '/_expo/plugins/expo-device-hub/api/devices/boot';

async function postAction(endpoint: string, device: Device): Promise<boolean> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // `id` is the udid (iOS) / serial (Android); `name` is the AVD name that
      // Android's `avdmanager delete avd` needs. The server ignores what it
      // doesn't use per platform.
      body: JSON.stringify({ platform: device.platform, id: device.id, name: device.name }),
    });
    if (!response.ok) throw new Error(`Unexpected ${response.status}`);
    const data = (await response.json()) as { ok?: boolean };
    return data.ok === true;
  } catch (error) {
    console.warn('[expo-device-hub] Device action failed:', error);
    return false;
  }
}

/** Shut the given device down. Resolves to whether the server reported success. */
export function shutdownDevice(device: Device): Promise<boolean> {
  return postAction(SHUTDOWN_ENDPOINT, device);
}

/** Remove/delete the given device. Resolves to whether the server reported success. */
export function removeDevice(device: Device): Promise<boolean> {
  return postAction(REMOVE_ENDPOINT, device);
}

/** Outcome of a {@link bootDevice} call: exactly one of the two is set. */
export interface BootDeviceOutcome {
  /** adb serial (`emulator-<port>`) of the booted emulator, on success. */
  serial: string | null;
  /** Human-readable failure reason (may span multiple lines), on failure. */
  error: string | null;
}

/**
 * Boot a shut-down Android emulator on the host, resolving to its adb serial
 * (`emulator-<port>`) once online, or the server's failure reason (e.g. the
 * emulator's own error output when the process died during boot). iOS sims boot
 * via serve-sim on connect, so this is only used for Android. Never throws.
 */
export async function bootDevice(device: Device): Promise<BootDeviceOutcome> {
  try {
    const response = await fetch(BOOT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ platform: device.platform, id: device.id, name: device.name }),
      // A cold emulator boot can take a couple of minutes.
      signal: AbortSignal.timeout(200_000),
    });
    if (!response.ok) throw new Error(`Unexpected ${response.status}`);
    const data = (await response.json()) as { ok?: boolean; serial?: string; error?: string };
    if (data.ok && data.serial) return { serial: data.serial, error: null };
    return { serial: null, error: data.error ?? 'The emulator did not come online.' };
  } catch (error) {
    console.warn('[expo-device-hub] Device boot failed:', error);
    return { serial: null, error: error instanceof Error ? error.message : String(error) };
  }
}
