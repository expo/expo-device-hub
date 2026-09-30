import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

import { withLaunchStateLockSync } from "../launch-state-lock";
import { stateDir } from "../state";
import { writeFileNoFollow } from "./no-follow";

const CAPTURE_DIR_PREFIX = "capture-";
export const CAPTURE_OWNER_FILENAME = "owner.pid";

function withArtifactLock<T>(dir: string, operation: () => T): T {
  const key = createHash("sha256").update(resolve(dir)).digest("hex");
  return withLaunchStateLockSync(`capture-artifacts-${key}`, operation);
}

/**
 * When a process started, as `ps` reports it, or null if that cannot be read. A PID is reused once its
 * process exits, so an owner file records its process's start time too; the PID with a different
 * start time is another process.
 */
export function processStartTime(pid: number): string | null {
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      // `lstart` is printed in the caller's locale and time zone; fixed values make the text from two
      // processes with different settings comparable.
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    }).trim();
    return started || null;
  } catch {
    return null;
  }
}

let ownStartTime: string | null | undefined;
function thisProcessStartTime(): string | null {
  if (ownStartTime === undefined) ownStartTime = processStartTime(process.pid);
  return ownStartTime;
}

/** Owner file: the PID, a random id for this claim, and the process start time (older files lack it). */
function ownerIsRunning(dir: string, ownerFile = CAPTURE_OWNER_FILENAME): boolean {
  let pid: number;
  let started: string | undefined;
  try {
    const lines = readFileSync(join(dir, ownerFile), "utf8").trim().split("\n");
    pid = Number(lines[0]);
    started = lines[2]?.trim() || undefined;
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
  if (!started) return true;
  const current = pid === process.pid ? thisProcessStartTime() : processStartTime(pid);
  // A start time that cannot be read keeps the recording: removing a live one would lose it.
  return current === null || current === started;
}

export function claimCaptureDirectory(dir: string, ownerFile = CAPTURE_OWNER_FILENAME): string {
  const ownerPath = join(dir, ownerFile);
  return withArtifactLock(dir, () => {
    if (ownerIsRunning(dir, ownerFile)) {
      throw new Error(
        `Another recording holds ${ownerPath}. Stop it before starting another for this device or HAR file.`,
      );
    }
    // Owner-only: the folder holds decrypted traffic, and the state dir may sit under a shared path.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // `mode` applies only to a folder mkdir creates; a session folder left by an earlier run keeps
    // whatever mode it had. A `capture har -o` folder is the user's (it may be /tmp) and is left alone.
    if (ownerFile === CAPTURE_OWNER_FILENAME && !lstatSync(dir).isSymbolicLink()) chmodSync(dir, 0o700);
    const started = thisProcessStartTime();
    const owner = `${process.pid}\n${randomUUID()}${started ? `\n${started}` : ""}`;
    writeFileNoFollow(ownerPath, owner);
    return owner;
  });
}

export function releaseCaptureDirectory(
  dir: string,
  owner: string,
  removeDir: boolean,
  ownerFile = CAPTURE_OWNER_FILENAME,
): void {
  const ownerPath = join(dir, ownerFile);
  withArtifactLock(dir, () => {
    let current: string;
    try {
      current = readFileSync(ownerPath, "utf8");
    } catch {
      return;
    }
    if (current !== owner) return;
    if (removeDir) rmSync(dir, { recursive: true, force: true });
    else unlinkSync(ownerPath);
  });
}

export function sweepAbandonedCaptureDirs(
  keepUdids: readonly string[],
  deps: {
    list?: () => string[];
    remove?: (dir: string) => void;
    ownedByLiveProcess?: (dir: string) => boolean;
  } = {},
): number {
  const owned = deps.ownedByLiveProcess ?? ownerIsRunning;
  const keep = new Set(keepUdids.map((udid) => `${CAPTURE_DIR_PREFIX}${udid}`));
  const list =
    deps.list ??
    (() => {
      try {
        return readdirSync(stateDir());
      } catch {
        return [];
      }
    });
  const remove = deps.remove ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));

  let swept = 0;
  for (const name of list()) {
    if (!name.startsWith(CAPTURE_DIR_PREFIX) || keep.has(name)) continue;
    const dir = join(stateDir(), name);
    try {
      withArtifactLock(dir, () => {
        if (owned(dir)) return;
        remove(dir);
        swept++;
      });
    } catch {}
  }
  return swept;
}
