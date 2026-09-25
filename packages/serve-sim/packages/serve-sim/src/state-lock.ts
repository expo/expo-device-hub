import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";

export const STATE_LOCK_POLL_MS = 50;

function lockHolderIsGone(path: string): boolean {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8").trim();
  } catch {
    return true;
  }
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

export async function withStateLock<T>(
  path: string,
  timeoutMs: number,
  timeoutError: () => Error,
  fn: () => Promise<T>,
): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let fd: number | undefined;
  while (fd === undefined) {
    if (Date.now() >= deadline) throw timeoutError();
    try {
      fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
    } catch {
      if (lockHolderIsGone(path)) {
        try { unlinkSync(path); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, STATE_LOCK_POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(path); } catch {}
  }
}

export function withStateLockSync<T>(
  path: string,
  timeoutMs: number,
  timeoutError: () => Error,
  reentrantError: () => Error,
  fn: () => T,
): T {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let fd: number;
  for (;;) {
    try {
      fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
      break;
    } catch {
      let holder: string | undefined;
      try { holder = readFileSync(path, "utf8").trim(); } catch {}
      if (holder === String(process.pid)) throw reentrantError();
      if (lockHolderIsGone(path)) {
        try { unlinkSync(path); } catch {}
      }
      if (Date.now() >= deadline) throw timeoutError();
      Atomics.wait(sleeper, 0, 0, STATE_LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(path); } catch {}
  }
}
