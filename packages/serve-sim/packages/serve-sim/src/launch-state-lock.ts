import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { stateDir } from "./state";

const LOCK_TIMEOUT_MS = 10_000;
export const LOCK_POLL_MS = 50;

function lockFile(udid: string): string {
  return join(stateDir(), `launch-${udid}.lock`);
}

function lockHolderIsGone(path: string): boolean {
  let contents: string;
  try {
    contents = readFileSync(path, "utf-8").trim();
  } catch {
    return true;
  }
  // Empty means another process created the file and has not written its pid
  // yet. That is held, not stale.
  if (contents === "") return false;
  const pid = Number(contents);
  if (!Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

const pendingLaunchUpdates = new Set<Promise<unknown>>();

export async function waitForLaunchUpdates(): Promise<void> {
  while (pendingLaunchUpdates.size) await Promise.allSettled([...pendingLaunchUpdates]);
}

export function withLaunchStateLock<T>(udid: string, fn: () => Promise<T>): Promise<T> {
  const update = acquireLaunchStateLock(udid, fn);
  pendingLaunchUpdates.add(update);
  return update.finally(() => pendingLaunchUpdates.delete(update));
}

async function acquireLaunchStateLock<T>(udid: string, fn: () => Promise<T>): Promise<T> {
  if (!existsSync(stateDir())) mkdirSync(stateDir(), { recursive: true });
  const path = lockFile(udid);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | undefined;

  while (fd === undefined) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting to update the launch state for ${udid}. Another serve-sim command ` +
          `is holding ${path}. Wait for it to finish, or remove that file if nothing is running.`,
      );
    }
    try {
      fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
    } catch {
      if (lockHolderIsGone(path)) {
        try { unlinkSync(path); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  try {
    return await fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(path); } catch {}
  }
}

export function withLaunchStateLockSync<T>(udid: string, fn: () => T): T {
  mkdirSync(stateDir(), { recursive: true });
  const path = lockFile(udid);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let fd: number;
  for (;;) {
    try {
      fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
      break;
    } catch {
      let holder: string | undefined;
      try { holder = readFileSync(path, "utf-8").trim(); } catch {}
      if (holder === String(process.pid)) {
        throw new Error(`Cannot release launch state for ${udid} while this process is updating it. Run cleanup again after the command finishes.`);
      }
      if (lockHolderIsGone(path)) {
        try { unlinkSync(path); } catch {}
      }
      if (Date.now() >= deadline) {
        throw new Error(`Could not release launch state for ${udid}: ${path} is still locked. Retry cleanup after the active command finishes.`);
      }
      Atomics.wait(sleeper, 0, 0, LOCK_POLL_MS);
    }
  }
  try { return fn(); } finally {
    closeSync(fd);
    try { unlinkSync(path); } catch {}
  }
}

