/**
 * Device lifecycle actions for the Expo Hub DevTools server: shutting a
 * simulator/emulator down and removing (deleting) it.
 *
 * These shell out through `@expo/hub-apple-utils` (`xcrun simctl`) and
 * `@expo/hub-android-utils` (`adb` / `avdmanager`). The dashboard's More menu
 * calls them via `POST /api/devices/shutdown` and `POST /api/devices/remove`
 * (see `index.ts`).
 */

import {
  removeDevice as removeAndroidDevice,
  shutdownDevice as shutdownAndroidDevice,
} from '@expo/hub-android-utils';
import {
  removeDevice as removeAppleDevice,
  shutdownDevice as shutdownAppleDevice,
} from '@expo/hub-apple-utils';

import { type HubDevicePlatform } from './devices';

/** A parsed `POST /api/devices/{shutdown,remove}` request body. */
export interface DeviceActionRequest {
  platform: HubDevicePlatform;
  /** udid (iOS) / adb serial (Android) of the device to act on. */
  id: string;
  /**
   * Device/AVD name. Android's `avdmanager delete avd` deletes by name, so
   * remove needs it; iOS acts purely by udid and ignores it.
   */
  name: string;
}

/**
 * Parse + validate a device-action request body. Returns `null` (so the caller
 * can answer 400) when the platform is unknown or the id is missing.
 */
export async function parseDeviceAction(request: Request): Promise<DeviceActionRequest | null> {
  let data: unknown;
  try {
    data = await request.json();
  } catch {
    return null;
  }

  if (!data || typeof data !== 'object') return null;
  const { platform, id, name } = data as Record<string, unknown>;

  if ((platform !== 'ios' && platform !== 'android') || typeof id !== 'string' || !id) {
    return null;
  }

  return { platform, id, name: typeof name === 'string' ? name : '' };
}

/** Shut a running simulator/emulator down. Resolves to whether it succeeded. */
export async function shutdownHubDevice({ platform, id }: DeviceActionRequest): Promise<boolean> {
  return platform === 'ios'
    ? shutdownAppleDevice({ udid: id })
    : shutdownAndroidDevice({ serial: id });
}

/**
 * Remove (delete) a simulator/emulator permanently. A running device can't be
 * cleanly deleted, so shut it down first (best-effort) and then delete: iOS by
 * udid, Android by AVD name.
 */
export async function removeHubDevice({ platform, id, name }: DeviceActionRequest): Promise<boolean> {
  if (platform === 'ios') {
    await shutdownAppleDevice({ udid: id });
    return removeAppleDevice({ udid: id });
  }

  await shutdownAndroidDevice({ serial: id });
  return removeAndroidDevice({ name });
}
