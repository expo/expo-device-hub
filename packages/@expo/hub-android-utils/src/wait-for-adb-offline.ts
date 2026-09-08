import { homedir } from "node:os";
import { runAdbDevices } from "./adb";
import { type AndroidUtilsError, type AndroidUtilsResult, reportError, result } from "./errors";
import { parseAdbDevices } from "./parse-adb-devices";
import { resolveAdbPath } from "./sdk-paths";

export const SHUTDOWN_POLL_INTERVAL_MS = 1500;

/** Lists the serials adb currently sees. Must finish within `timeoutMs` and stop on `signal`. */
export type ListAdbSerialsFn = (options: {
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<AndroidUtilsResult<string[]>>;

const listAdbSerials: ListAdbSerialsFn = async (options) => {
  const adb = resolveAdbPath(process.env, homedir());
  const listed = await runAdbDevices(adb, options);
  if (listed.error) return result([], listed.error);
  return result(listed.value ? parseAdbDevices(listed.value).map((device) => device.serial) : []);
};

export interface WaitForAdbOfflineOptions {
  listSerialsFn?: ListAdbSerialsFn;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

/** Resolve `null` after `ms`, or as soon as `signal` aborts. `cancel` drops the timer and listener. */
function startExpiry(
  ms: number,
  signal: AbortSignal | undefined,
): { promise: Promise<null>; cancel: () => void } {
  let cancel = () => {};
  const promise = new Promise<null>((resolve) => {
    const expire = () => {
      cancel();
      resolve(null);
    };
    const timer = setTimeout(expire, ms);
    cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", expire);
    };
    signal?.addEventListener("abort", expire, { once: true });
  });
  return { promise, cancel };
}

/** Run one listing and turn any throw into a failed result, so it never rejects. */
async function listSafely(
  listSerialsFn: ListAdbSerialsFn,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<AndroidUtilsResult<string[]>> {
  try {
    return await listSerialsFn({ timeoutMs, signal });
  } catch (error) {
    return result<string[]>(
      [],
      reportError(
        "[android-utils] Failed to poll adb while waiting for it to release the serial:",
        error,
      ),
    );
  }
}

/** Await one listing, or give up with `null` once `timeoutMs` elapses or `signal` aborts. */
async function listWithinBudget(
  listSerialsFn: ListAdbSerialsFn,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<AndroidUtilsResult<string[]> | null> {
  const expiry = startExpiry(timeoutMs, signal);
  try {
    return await Promise.race([listSafely(listSerialsFn, timeoutMs, signal), expiry.promise]);
  } finally {
    expiry.cancel();
  }
}

/**
 * Poll `adb devices -l` until `serial` is gone from it, or time out.
 *
 * Its result `value` becomes `true` on the first successful listing that no
 * longer carries `serial`, or `false` once the timeout elapses or the signal
 * aborts. A failed listing does not end the wait; the last failure is returned
 * in `error` alongside `false`.
 *
 * Each listing gets the remaining budget and the signal, so a stalled adb
 * cannot hold the wait open. A listing that arrives after the deadline or after
 * an abort is discarded rather than accepted, so the wait never reports `true`
 * on stale output.
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
    const listed = await listWithinBudget(listSerialsFn, deadline - Date.now(), signal);
    if (listed === null || signal?.aborted || Date.now() >= deadline) {
      return result(false, listed?.error ?? lastError);
    }
    if (listed.error) {
      lastError = listed.error;
    } else if (!listed.value.includes(serial)) {
      return result(true);
    }
    await startExpiry(Math.min(pollIntervalMs, deadline - Date.now()), signal).promise;
  }
  return result(false, lastError);
}
