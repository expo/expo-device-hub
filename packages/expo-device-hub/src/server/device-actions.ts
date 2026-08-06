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
import { type SerializableError, toSerializableError } from './utility-errors';

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

export interface DeviceActionResult {
  ok: boolean;
  errors: SerializableError[];
}

function errorList(error: SerializableError | null): SerializableError[] {
  return error ? [error] : [];
}

/** Shut a running simulator/emulator down. Resolves to whether it succeeded. */
export async function shutdownHubDevice({
  platform,
  id,
}: DeviceActionRequest): Promise<DeviceActionResult> {
  if (platform === 'ios') {
    const result = await shutdownAppleDevice({ udid: id });
    return { ok: result.value, errors: errorList(toSerializableError(result.error)) };
  }

  const result = await shutdownAndroidDevice({ serial: id });
  return { ok: result.value, errors: errorList(toSerializableError(result.error)) };
}

/**
 * Remove (delete) a simulator/emulator permanently. A running device can't be
 * cleanly deleted, so shut it down first and then delete: iOS by udid, Android
 * by AVD name. A shutdown error stops the operation before deletion.
 */
export async function removeHubDevice({
  platform,
  id,
  name,
}: DeviceActionRequest): Promise<DeviceActionResult> {
  if (platform === 'ios') {
    const shutdown = await shutdownAppleDevice({ udid: id });
    if (shutdown.error || !shutdown.value) {
      return {
        ok: false,
        errors: errorList(toSerializableError(shutdown.error)),
      };
    }

    const removed = await removeAppleDevice({ udid: id });
    return {
      ok: removed.value,
      errors: errorList(toSerializableError(removed.error)),
    };
  }

  const shutdown = await shutdownAndroidDevice({ serial: id });
  if (shutdown.error || !shutdown.value) {
    return {
      ok: false,
      errors: errorList(toSerializableError(shutdown.error)),
    };
  }

  const removed = await removeAndroidDevice({ name });
  return {
    ok: removed.value,
    errors: errorList(toSerializableError(removed.error)),
  };
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
  errors: SerializableError[];
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
    const booted = await bootAppleSimulator({ udid: id });
    const errors = errorList(toSerializableError(booted.error));
    return booted.value
      ? { ok: true, id, errors }
      : { ok: false, id, error: `Failed to boot iOS simulator ${name || id}`, errors };
  }

  const avdName = name || id;
  if (!avdName) return { ok: false, error: 'Missing AVD name', errors: [] };

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
    const created = await createAppleSimulator({ name, runtime, deviceType });
    const udid = created.value;
    if (created.error || !udid) {
      return {
        ok: false,
        error: `Failed to create iOS simulator ${name}`,
        errors: errorList(toSerializableError(created.error)),
      };
    }

    const booted = await bootAppleSimulator({ udid });
    const errors = errorList(toSerializableError(booted.error));
    return booted.value
      ? { ok: true, id: udid, errors }
      : {
          ok: false,
          id: udid,
          error: `Created ${name}, but failed to boot it`,
          errors,
        };
  }

  const created = await createAndroidDevice({
    name,
    package: runtime,
    device: deviceType,
  });
  if (created.error || !created.value) {
    return {
      ok: false,
      error: `Failed to create Android emulator ${name}`,
      errors: errorList(toSerializableError(created.error)),
    };
  }

  return bootAndroidHubDevice(name);
}

async function bootAndroidHubDevice(avdName: string): Promise<BootDeviceResult> {
  const allocated = await freeEmulatorPort();
  if (allocated.error || allocated.value === null) {
    return {
      ok: false,
      error: `Failed to allocate an emulator port for ${avdName}`,
      errors: errorList(toSerializableError(allocated.error)),
    };
  }

  const bootedResult = await bootAndroidEmulator({ name: avdName, port: allocated.value });
  const booted = bootedResult.value;
  if (bootedResult.error || !booted) {
    return {
      ok: false,
      error: `Failed to spawn emulator for ${avdName}`,
      errors: errorList(toSerializableError(bootedResult.error)),
    };
  }

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
      errors: errorList(toSerializableError(outcome.exit.error)),
    };
  }

  if (outcome.online.error) {
    return {
      ok: false,
      id: booted.serial,
      serial: booted.serial,
      error: `Failed while waiting for ${avdName} to come online`,
      errors: errorList(toSerializableError(outcome.online.error)),
    };
  }

  return outcome.online.value
    ? { ok: true, id: booted.serial, serial: booted.serial, errors: [] }
    : {
        ok: false,
        id: booted.serial,
        serial: booted.serial,
        error: 'Timed out waiting for the emulator to come online',
        errors: [],
      };
}
