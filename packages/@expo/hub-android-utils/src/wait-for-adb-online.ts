import { listDevices } from "./list-devices";
import type { AndroidDevice } from "./types";

/** Default delay between adb-online polls in {@link waitForAdbOnline}. */
export const BOOT_POLL_INTERVAL_MS = 1500;

/** Options for {@link waitForAdbOnline}; the first two are injectable for testing. */
export interface WaitForAdbOnlineOptions {
  /** Device lister to poll. Defaults to {@link listDevices}. */
  listDevicesFn?: () => Promise<AndroidDevice[]>;
  /** Delay between polls in ms. Defaults to {@link BOOT_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Stops the wait early (resolving `false`), e.g. once the emulator process died. */
  signal?: AbortSignal;
}

/**
 * Poll `listDevices` until `serial` shows up booted (adb-online), or time out.
 *
 * Resolves `true` as soon as a device with the given `serial` reports `booted`,
 * or `false` once `timeoutMs` has elapsed or `signal` aborts. Errors from the
 * device lister are swallowed so a transient `adb` hiccup doesn't abort the
 * wait.
 */
export async function waitForAdbOnline(
  serial: string,
  timeoutMs: number,
  {
    listDevicesFn = listDevices,
    pollIntervalMs = BOOT_POLL_INTERVAL_MS,
    signal,
  }: WaitForAdbOnlineOptions = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      const devices = await listDevicesFn();
      if (devices.some((device) => device.serial === serial && device.booted)) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}
