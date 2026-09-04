import { type AndroidUtilsError, type AndroidUtilsResult, reportError, result } from "./errors";
import { listDevices } from "./list-devices";
import type { AndroidDevice } from "./types";

/** Default delay between adb-offline polls in {@link waitForAdbOffline}. */
export const SHUTDOWN_POLL_INTERVAL_MS = 1500;

/** Options for {@link waitForAdbOffline}; the first two are injectable for testing. */
export interface WaitForAdbOfflineOptions {
  /** Device lister to poll. Defaults to {@link listDevices}. */
  listDevicesFn?: () => Promise<AndroidUtilsResult<AndroidDevice[]>>;
  /** Delay between polls in ms. Defaults to {@link SHUTDOWN_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Stops the wait early (resolving `false`). */
  signal?: AbortSignal;
}

/**
 * Poll `listDevices` until `serial` is gone from adb, or time out.
 *
 * Its result `value` becomes `true` on the first clean listing that no longer
 * carries `serial`, or `false` once the timeout elapses or the signal aborts.
 * A failed listing counts as still attached: adb keeps serving the serial of an
 * exiting emulator, and `getprop` against it fails for the whole of that
 * window. The last such failure comes back in `error` alongside `false`.
 */
export async function waitForAdbOffline(
  serial: string,
  timeoutMs: number,
  {
    listDevicesFn = listDevices,
    pollIntervalMs = SHUTDOWN_POLL_INTERVAL_MS,
    signal,
  }: WaitForAdbOfflineOptions = {},
): Promise<AndroidUtilsResult<boolean>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: AndroidUtilsError | null = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) return result(false, lastError);
    try {
      const listed = await listDevicesFn();
      if (listed.error) {
        lastError = listed.error;
      } else if (!listed.value.some((device) => device.serial === serial)) {
        return result(true);
      }
    } catch (error) {
      lastError = reportError(
        "[android-utils] Failed to poll devices while waiting for adb to release the serial:",
        error,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return result(false, lastError);
}
