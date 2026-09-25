import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { withLaunchStateLockSync } from "../launch-state-lock";
import { stateDir } from "../state";

const CAPTURE_DIR_PREFIX = "capture-";
export const CAPTURE_OWNER_FILENAME = "owner.pid";

function withArtifactLock<T>(dir: string, operation: () => T): T {
  const key = createHash("sha256").update(resolve(dir)).digest("hex");
  return withLaunchStateLockSync(`capture-artifacts-${key}`, operation);
}

function ownerIsRunning(dir: string, ownerFile = CAPTURE_OWNER_FILENAME): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(join(dir, ownerFile), "utf8").trim().split("\n")[0]);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

export function claimCaptureDirectory(dir: string, ownerFile = CAPTURE_OWNER_FILENAME): string {
  const ownerPath = join(dir, ownerFile);
  return withArtifactLock(dir, () => {
    if (ownerIsRunning(dir, ownerFile)) {
      throw new Error(
        `Another recording holds ${ownerPath}. Stop it before starting another for this device or HAR file.`,
      );
    }
    mkdirSync(dir, { recursive: true });
    const owner = `${process.pid}\n${randomUUID()}`;
    writeFileSync(ownerPath, owner);
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
