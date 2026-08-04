/**
 * Device lifecycle actions for the Expo Hub DevTools server: creating,
 * booting, shutting down, and removing simulators/emulators.
 *
 * These shell out through `@expo/hub-apple-utils` (`xcrun simctl`) and
 * `@expo/hub-android-utils` (`adb` / `avdmanager` / `emulator`). The dashboard
 * calls them via `POST /api/devices/{create,shutdown,remove,boot}` (see `index.ts`).
 */

import {
  bootDevice as bootAndroidEmulator,
  createDevice as createAndroidDevice,
  freeEmulatorPort,
  removeDevice as removeAndroidDevice,
  shutdownDevice as shutdownAndroidDevice,
  waitForAdbOnline,
} from '@expo/hub-android-utils';
import {
  bootDevice as bootAppleSimulator,
  createDevice as createAppleSimulator,
  removeDevice as removeAppleDevice,
  shutdownDevice as shutdownAppleDevice,
} from '@expo/hub-apple-utils';

import { type HubDevicePlatform } from './devices';

const ANDROID_AVD_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

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

/** Parsed body for `POST /api/devices/create`. */
export interface CreateDeviceActionRequest {
  platform: HubDevicePlatform;
  name: string;
  /** Runtime identifier (iOS) or installed system-image package (Android). */
  runtime: string;
  /** Simulator device type (iOS) or AVD device profile (Android). */
  deviceType: string;
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

/** Parse and validate the stable toolchain identifiers needed to create a device. */
export async function parseCreateDeviceAction(
  request: Request
): Promise<CreateDeviceActionRequest | null> {
  let data: unknown;
  try {
    data = await request.json();
  } catch {
    return null;
  }

  if (!data || typeof data !== 'object') return null;
  const { platform, name, runtime, deviceType } = data as Record<string, unknown>;
  if (
    (platform !== 'ios' && platform !== 'android') ||
    !isNonEmptyString(name) ||
    !isNonEmptyString(runtime) ||
    !isNonEmptyString(deviceType) ||
    (platform === 'android' && !ANDROID_AVD_NAME_PATTERN.test(name.trim()))
  ) {
    return null;
  }

  return {
    platform,
    name: name.trim(),
    runtime: runtime.trim(),
    deviceType: deviceType.trim(),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
export async function removeHubDevice({
  platform,
  id,
  name,
}: DeviceActionRequest): Promise<boolean> {
  if (platform === 'ios') {
    await shutdownAppleDevice({ udid: id });
    return removeAppleDevice({ udid: id });
  }

  await shutdownAndroidDevice({ serial: id });
  return removeAndroidDevice({ name });
}

const BOOT_READY_TIMEOUT_MS = 180_000;

/** Result of a create/boot request — the streamable device id once accepted. */
export interface BootDeviceResult {
  ok: boolean;
  /** iOS simulator UDID or Android adb serial. */
  id?: string;
  /** Backwards-compatible Android adb serial. */
  serial?: string;
  error?: string;
}

/**
 * Boot a shut-down simulator/emulator through the platform utility. Android
 * waits until the new adb serial is online; iOS returns after `simctl` accepts
 * the boot and uses the existing UDID as its stream id.
 *
 * The wait races against the emulator process dying: a bad AVD/config kills the
 * process within seconds, and burning the full 3-minute timeout on a corpse
 * would leave the dashboard with a meaningless "timed out". The emulator's
 * output isn't captured (the detached child outlives this server), so an early
 * exit reports the exit code plus the exact command to re-run for the details.
 */
export async function bootHubDevice({
  platform,
  id,
  name,
}: DeviceActionRequest): Promise<BootDeviceResult> {
  if (platform === 'ios') {
    const ok = await bootAppleSimulator({ udid: id });
    return ok
      ? { ok: true, id }
      : { ok: false, id, error: `Failed to boot iOS simulator ${name || id}` };
  }

  const avdName = name || id;
  if (!avdName) return { ok: false, error: 'Missing AVD name' };

  return bootAndroidHubDevice(avdName);
}

/** Create a new virtual device, then boot it through the same platform utility. */
export async function createHubDevice({
  platform,
  name,
  runtime,
  deviceType,
}: CreateDeviceActionRequest): Promise<BootDeviceResult> {
  if (platform === 'ios') {
    const udid = await createAppleSimulator({ name, runtime, deviceType });
    if (!udid) return { ok: false, error: `Failed to create iOS simulator ${name}` };

    const booted = await bootAppleSimulator({ udid });
    return booted
      ? { ok: true, id: udid }
      : { ok: false, id: udid, error: `Created ${name}, but failed to boot it` };
  }

  const created = await createAndroidDevice({
    name,
    package: runtime,
    device: deviceType,
  });
  if (!created) return { ok: false, error: `Failed to create Android emulator ${name}` };

  return bootAndroidHubDevice(name);
}

async function bootAndroidHubDevice(avdName: string): Promise<BootDeviceResult> {
  const port = await freeEmulatorPort();
  const booted = bootAndroidEmulator({ name: avdName, port });
  if (!booted) return { ok: false, error: `Failed to spawn emulator for ${avdName}` };

  const abort = new AbortController();
  const outcome = await Promise.race([
    waitForAdbOnline(booted.serial, BOOT_READY_TIMEOUT_MS, { signal: abort.signal }).then(
      (online) => ({ kind: 'wait' as const, online })
    ),
    booted.exited.then((exit) => ({ kind: 'exited' as const, exit })),
  ]);
  abort.abort();

  if (outcome.kind === 'exited') {
    const ended =
      outcome.exit.code != null
        ? `exited with code ${outcome.exit.code}`
        : outcome.exit.signal
          ? `was killed by ${outcome.exit.signal}`
          : 'exited';
    return {
      ok: false,
      id: booted.serial,
      serial: booted.serial,
      error:
        `The emulator process for "${avdName}" ${ended} before coming online.\n\n` +
        `For details, try running it manually:\n${booted.command}`,
    };
  }

  return outcome.online
    ? { ok: true, id: booted.serial, serial: booted.serial }
    : {
        ok: false,
        id: booted.serial,
        serial: booted.serial,
        error: 'Timed out waiting for the emulator to come online',
      };
}
