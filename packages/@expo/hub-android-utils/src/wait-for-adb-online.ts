import { type AndroidUtilsResult, reportError, result } from "./errors";
import { listDevices } from "./list-devices";
import type { AndroidDevice } from "./types";

/** Default delay between adb-online polls in {@link waitForAdbOnline}. */
export const BOOT_POLL_INTERVAL_MS = 1500;

/** Options for {@link waitForAdbOnline}; the first two are injectable for testing. */
export interface WaitForAdbOnlineOptions {
  /** Device lister to poll. Defaults to {@link listDevices}. */
  listDevicesFn?: () => Promise<AndroidUtilsResult<AndroidDevice[]>>;
  /** Delay between polls in ms. Defaults to {@link BOOT_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Stops the wait early (resolving `false`), e.g. once the emulator process died. */
  signal?: AbortSignal;
}

/**
 * Poll `listDevices` until `serial` shows up booted (adb-online), or time out.
 *
 * Its result `value` becomes `true` as soon as the serial reports `booted`, or
 * `false` once the timeout elapses or the signal aborts. A discovery failure
 * returns immediately in `error`.
 */
export async function waitForAdbOnline(
  serial: string,
  timeoutMs: number,
  {
    listDevicesFn = listDevices,
    pollIntervalMs = BOOT_POLL_INTERVAL_MS,
    signal,
  }: WaitForAdbOnlineOptions = {},
): Promise<AndroidUtilsResult<boolean>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return result(false);
    try {
      const listed = await listDevicesFn();
      if (listed.error) return result(false, listed.error);
      if (listed.value.some((device) => device.serial === serial && device.booted)) {
        return result(true);
      }
    } catch (error) {
      return result(
        false,
        reportError("[android-utils] Failed to poll devices while waiting for adb:", error),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return result(false);
}
