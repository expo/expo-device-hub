import { join } from "path";
import { stateDir } from "./state";
import { STATE_LOCK_POLL_MS, withStateLock, withStateLockSync } from "./state-lock";

// Allow time for the holder to build, terminate, and relaunch an app.
const LOCK_TIMEOUT_MS = 90_000;
export const LOCK_POLL_MS = STATE_LOCK_POLL_MS;

function lockFile(udid: string): string {
  return join(stateDir(), `launch-${udid}.lock`);
}

const pendingLaunchUpdates = new Set<Promise<unknown>>();

export async function waitForLaunchUpdates(): Promise<void> {
  while (pendingLaunchUpdates.size) await Promise.allSettled(pendingLaunchUpdates);
}

export function withLaunchStateLock<T>(udid: string, fn: () => Promise<T>): Promise<T> {
  const update = acquireLaunchStateLock(udid, fn);
  pendingLaunchUpdates.add(update);
  return update.finally(() => pendingLaunchUpdates.delete(update));
}

async function acquireLaunchStateLock<T>(udid: string, fn: () => Promise<T>): Promise<T> {
  const path = lockFile(udid);
  return withStateLock(
    path,
    LOCK_TIMEOUT_MS,
    () => new Error(
      `Timed out after ${LOCK_TIMEOUT_MS / 1000}s waiting to update the launch state for ` +
        `${udid}. Another serve-sim command on this machine is holding ${path}. A lock left by ` +
        `a dead process is reclaimed on its own, so wait for that command to finish.`,
    ),
    fn,
  );
}

export function withLaunchStateLockSync<T>(udid: string, fn: () => T): T {
  const path = lockFile(udid);
  return withStateLockSync(
    path,
    LOCK_TIMEOUT_MS,
    () => new Error(`Could not release launch state for ${udid}: ${path} is still locked. Retry cleanup after the active command finishes.`),
    () => new Error(`Cannot release launch state for ${udid} while this process is updating it. Run cleanup again after the command finishes.`),
    fn,
  );
}
