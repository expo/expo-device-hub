import { type Device, type NewDeviceRequest } from '@expo/hub-components';

import { basePath } from './basePath';
import { logUtilityErrors, type UtilityError } from './utilityErrors';

/**
 * Device lifecycle actions, posted to the Hub server (see
 * `src/server/device-actions.ts`) under whatever mount `basePath()`
 * resolves (the Expo CLI plugin prefix, or wherever the standalone CLI
 * mounts it).
 *
 * Each resolves to whether the server reported success and never throws — the
 * dashboard just refreshes its list afterward regardless.
 */
const shutdownEndpoint = () => `${basePath()}/api/devices/shutdown`;
const removeEndpoint = () => `${basePath()}/api/devices/remove`;
const bootEndpoint = () => `${basePath()}/api/devices/boot`;
const createEndpoint = () => `${basePath()}/api/devices/create`;

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
    const data = (await response.json()) as { ok?: boolean; errors?: UtilityError[] };
    logUtilityErrors(data.errors);
    return data.ok === true;
  } catch (error) {
    console.warn('[expo-device-hub] Device action failed:', error);
    return false;
  }
}

/** Shut the given device down. Resolves to whether the server reported success. */
export function shutdownDevice(device: Device): Promise<boolean> {
  return postAction(shutdownEndpoint(), device);
}

/** Remove/delete the given device. Resolves to whether the server reported success. */
export function removeDevice(device: Device): Promise<boolean> {
  return postAction(removeEndpoint(), device);
}

/** Outcome of a create/boot call: exactly one of `id` and `error` is set. */
export interface StartDeviceOutcome {
  /** iOS simulator UDID or Android adb serial, on success. */
  id: string | null;
  /** Human-readable failure reason (may span multiple lines), on failure. */
  error: string | null;
}

/**
 * Boot a shut-down simulator/emulator on the host, resolving to its iOS UDID or
 * Android adb serial once accepted/online. Never throws.
 */
export async function bootDevice(
  device: Device,
  options?: { camera?: boolean }
): Promise<StartDeviceOutcome> {
  return postStartDevice(bootEndpoint(), {
    platform: device.platform,
    id: device.id,
    name: device.name,
    camera: options?.camera === true,
  });
}

/** Create and boot a new simulator/emulator from host toolchain identifiers. */
export async function createDevice(device: NewDeviceRequest): Promise<StartDeviceOutcome> {
  return postStartDevice(createEndpoint(), {
    platform: device.platform,
    name: device.name,
    runtime: device.runtime,
    deviceType: device.deviceType,
  });
}

async function postStartDevice(
  endpoint: string,
  body: Record<string, string | boolean>
): Promise<StartDeviceOutcome> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      // A cold emulator boot can take a couple of minutes.
      signal: AbortSignal.timeout(200_000),
    });
    const data = (await response.json()) as {
      ok?: boolean;
      id?: string;
      serial?: string;
      error?: string;
      errors?: UtilityError[];
    };
    logUtilityErrors(data.errors);
    if (!response.ok) {
      return { id: null, error: data.error ?? `Unexpected ${response.status}` };
    }
    const id = data.id ?? data.serial;
    if (data.ok && id) return { id, error: null };
    return { id: null, error: data.error ?? 'The device did not come online.' };
  } catch (error) {
    console.warn('[expo-device-hub] Device start failed:', error);
    return { id: null, error: error instanceof Error ? error.message : String(error) };
  }
}
