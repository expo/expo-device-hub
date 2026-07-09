/**
 * Device lifecycle actions for the Expo Hub DevTools server: shutting a
 * simulator/emulator down and removing (deleting) it.
 *
 * These shell out through `@expo/hub-apple-utils` (`xcrun simctl`) and
 * `@expo/hub-android-utils` (`adb` / `avdmanager` / `emulator`). The dashboard
 * calls them via `POST /api/devices/{shutdown,remove,boot}` (see `index.ts`).
 */

import {
  bootDevice as bootAndroidEmulator,
  freeEmulatorPort,
  removeDevice as removeAndroidDevice,
  shutdownDevice as shutdownAndroidDevice,
  waitForAdbOnline,
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

const BOOT_READY_TIMEOUT_MS = 180_000;

/** Result of a boot request — the adb serial once the emulator is online. */
export interface BootDeviceResult {
  ok: boolean;
  /** adb serial of the booted emulator (`emulator-<port>`), when it came up. */
  serial?: string;
  error?: string;
}

/**
 * Boot a shut-down Android emulator (iOS boots via serve-sim on connect, so this
 * is Android-only). Spawns `emulator -avd <name> -port <port>`, waits until that
 * emulator's serial is adb-online, and returns the serial so the client can
 * stream it via serve-emu (which keys off the adb serial, not the AVD name).
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
  if (platform !== 'android') {
    return { ok: false, error: 'Boot is Android-only; iOS simulators boot via serve-sim.' };
  }

  const avdName = name || id;
  if (!avdName) return { ok: false, error: 'Missing AVD name' };

  const port = await freeEmulatorPort();
  const booted = bootAndroidEmulator({ name: avdName, port });
  if (!booted) return { ok: false, error: `Failed to spawn emulator for ${avdName}` };

  const abort = new AbortController();
  const outcome = await Promise.race([
    waitForAdbOnline(booted.serial, BOOT_READY_TIMEOUT_MS, { signal: abort.signal }).then(
      (online) => ({ kind: 'wait' as const, online }),
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
      serial: booted.serial,
      error:
        `The emulator process for "${avdName}" ${ended} before coming online.\n\n` +
        `For details, try running it manually:\n${booted.command}`,
    };
  }

  return outcome.online
    ? { ok: true, serial: booted.serial }
    : { ok: false, serial: booted.serial, error: 'Timed out waiting for the emulator to come online' };
}
