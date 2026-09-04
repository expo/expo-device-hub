import { homedir } from "node:os";
import { runAdbDevices } from "./adb";
import { type AndroidUtilsError, type AndroidUtilsResult, reportError, result } from "./errors";
import { parseAdbDevices } from "./parse-adb-devices";
import { resolveAdbPath } from "./sdk-paths";

/** Default delay between adb-offline polls in {@link waitForAdbOffline}. */
export const SHUTDOWN_POLL_INTERVAL_MS = 1500;

/** The serials `adb devices -l` currently lists, whatever state each is in. */
async function listAdbSerials(): Promise<AndroidUtilsResult<string[]>> {
  const adb = resolveAdbPath(process.env, homedir());
  const listed = await runAdbDevices(adb);
  if (listed.error) return result([], listed.error);
  return result(listed.value ? parseAdbDevices(listed.value).map((device) => device.serial) : []);
}

/** Options for {@link waitForAdbOffline}; the first two are injectable for testing. */
export interface WaitForAdbOfflineOptions {
  /** Serial lister to poll. Defaults to {@link listAdbSerials}. */
  listSerialsFn?: () => Promise<AndroidUtilsResult<string[]>>;
  /** Delay between polls in ms. Defaults to {@link SHUTDOWN_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Stops the wait early (resolving `false`). */
  signal?: AbortSignal;
}

/**
 * Poll `adb devices -l` until `serial` is gone from it, or time out.
 *
 * Its result `value` becomes `true` on the first successful listing that no
 * longer carries `serial`, or `false` once the timeout elapses or the signal
 * aborts. Only the raw listing is read: inspecting each device (as
 * `listDevices` does) fails for the whole listing whenever any one device is
 * locked or on its way out, which is exactly the window this waits through. A
 * listing that fails outright means adb itself is unreachable, so the wait
 * keeps polling and returns that last failure in `error` alongside `false`.
 */
export async function waitForAdbOffline(
  serial: string,
  timeoutMs: number,
  {
    listSerialsFn = listAdbSerials,
    pollIntervalMs = SHUTDOWN_POLL_INTERVAL_MS,
    signal,
  }: WaitForAdbOfflineOptions = {},
): Promise<AndroidUtilsResult<boolean>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: AndroidUtilsError | null = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) return result(false, lastError);
    try {
      const listed = await listSerialsFn();
      if (listed.error) {
        lastError = listed.error;
      } else if (!listed.value.includes(serial)) {
        return result(true);
      }
    } catch (error) {
      lastError = reportError(
        "[android-utils] Failed to poll adb while waiting for it to release the serial:",
        error,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return result(false, lastError);
}
