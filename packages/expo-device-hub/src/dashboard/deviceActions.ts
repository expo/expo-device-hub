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
