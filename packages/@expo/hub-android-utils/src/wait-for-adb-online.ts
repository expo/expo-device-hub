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
  /** Stops the wait early (resolving `null`), e.g. once the emulator process died. */
  signal?: AbortSignal;
}

/**
 * Poll `listDevices` until `serial` shows up booted (adb-online), or time out.
 *
 * Its result `value` becomes the name of the device at `serial` (for an
 * emulator, the AVD it runs) as soon as the serial reports `booted`, or `null`
 * once the timeout elapses or the signal aborts. A caller that booted an AVD
 * on that serial compares the name: another emulator may already hold the
 * port. A discovery failure returns immediately in `error`.
 */
export async function waitForAdbOnline(
  serial: string,
  timeoutMs: number,
  {
    listDevicesFn = listDevices,
    pollIntervalMs = BOOT_POLL_INTERVAL_MS,
    signal,
  }: WaitForAdbOnlineOptions = {},
): Promise<AndroidUtilsResult<string | null>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return result(null);
    try {
      const listed = await listDevicesFn();
      if (listed.error) return result(null, listed.error);
      const online = listed.value.find((device) => device.serial === serial && device.booted);
      if (online) return result(online.name);
    } catch (error) {
      return result(
        null,
        reportError("[android-utils] Failed to poll devices while waiting for adb:", error),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return result(null);
}
