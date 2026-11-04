import { randomUUID } from "crypto";
import {
  appendFile,
  chmod,
  lstat,
  mkdtemp,
  opendir,
  readdir,
  readlink,
  rm,
  writeFile,
} from "fs/promises";
import { basename, dirname, join, relative } from "path";
import type { Stats } from "fs";
import { z } from "zod";

import {
  type HostActionResult,
  createSerialQueue,
  actionTimeoutMs,
  runInvocation,
  ensurePrivateDirAsync,
  ok,
  pruneStaleEntriesAsync,
} from "./host-actions-utils";
import { UPLOAD_DIR, UPLOAD_ROOT } from "./host-paths";
import { resolveAppSourceLink, type AppSourceLink } from "./app-source-links";

// Without a ceiling a caller could fill the disk, and a closed tab never cleans up after itself.
const MAX_UPLOAD_DIR_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_UPLOAD_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_SNAPSHOT_ENTRIES = 100_000;
// UploadId refuses leading dots, so clients cannot exempt their uploads from age pruning.
const SNAPSHOT_PREFIX = ".install-snapshot-";
// Serialized so the budget check and the write cannot interleave: concurrent callers would
// otherwise all read the same pre-write total and sail past the ceiling.
const queueUploadAsync = createSerialQueue();
let snapshotBytes = 0;
const failedSnapshotCleanup = new Map<string, number>();

/** Copied bundles may have read-only directories. Never chmod through their symlinks. */
async function removeUploadTreeAsync(path: string): Promise<void> {
  const makeWritable = async (path: string): Promise<void> => {
    let info: Stats;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!info.isDirectory()) return;
    if ((info.mode & 0o700) !== 0o700) await chmod(path, (info.mode & 0o777) | 0o700);
    for await (const entry of await opendir(path))
      if (entry.isDirectory()) await makeWritable(join(path, entry.name));
  };
  await makeWritable(path);
  await rm(path, { recursive: true, force: true });
}

async function removeSnapshotAsync(directory: string, size: number): Promise<void> {
  try {
    await removeUploadTreeAsync(directory);
    snapshotBytes -= size;
  } catch (error) {
    // Retained files still consume the budget. Retry before accepting another
    // snapshot, without replacing the install result or its original error.
    failedSnapshotCleanup.set(directory, size);
    console.warn("[uploads] App snapshot cleanup will be retried before the next install:", error);
  }
}

export const UploadId = z
  .string()
  .regex(/^(?!\.)[A-Za-z0-9._-]{1,128}$/, "must be a short plain file name");

/** ~3MB of raw bytes, matching the client's 192KB slices with generous headroom. */
export const UploadChunk = z
  .base64()
  .min(1)
  .max(4 * 1024 * 1024);

/** The folder name UPLOAD_DIR uses: the owner's pid, then a random suffix. */
const SERVER_FOLDER = /^(\d+)-[0-9a-f]{8}$/;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes the folders of servers that exited and every upload past its age, in any server's folder,
 * then reports the bytes all servers still hold. Deleting is safe across servers: a copy that already
 * opened its source keeps reading the unlinked file, and a later open fails instead of mixing bytes.
 * Private snapshots are exempt from upload age until their action deadline; PID reuse cannot
 * preserve an abandoned snapshot indefinitely. Completed tasks remove their copies in finally.
 */
async function pruneStagingAsync(): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(UPLOAD_ROOT);
  } catch {
    return 0;
  }
  let held = 0;
  for (const entry of entries) {
    const full = join(UPLOAD_ROOT, entry);
    const owner = SERVER_FOLDER.exec(entry);
    if (!owner) continue;
    if (full !== UPLOAD_DIR && !isRunning(Number(owner[1]))) {
      await rm(full, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    held += await pruneStaleEntriesAsync(full, MAX_UPLOAD_AGE_MS, (entry) => {
      const deadline = /^\.install-(?:extract|snapshot)-(\d+)-/.exec(entry)?.[1];
      return deadline === undefined || Number(deadline) <= Date.now();
    });
  }
  // Files that earlier versions staged directly in the root.
  return (
    held +
    (await pruneStaleEntriesAsync(
      UPLOAD_ROOT,
      MAX_UPLOAD_AGE_MS,
      (entry) => !SERVER_FOLDER.test(entry),
    ))
  );
}

export function stagedUploadPath(uploadId: string): string {
  return join(UPLOAD_DIR, uploadId);
}

/** Recognize only this server's flat staging files, whose mutations this queue owns. */
export function getStagedUploadId(path: string): string | undefined {
  return dirname(path) === UPLOAD_DIR ? basename(path) : undefined;
}

/** Hold the staging queue while a reader captures bytes, excluding reset, prune and removal. */
// @ref LLP 0003#uploading-an-app-fixture — resets, pruning and removals wait while a copy reads its source
export function readStagedUploadAsync<T>(
  uploadId: string,
  read: (path: string) => Promise<T>,
): Promise<T> {
  return queueUploadAsync(() => read(stagedUploadPath(uploadId)));
}

/** Snapshot accepted installs without holding the shared staging queue through simctl. */
export async function withStagedUploadSnapshotAsync<T>(
  uploadId: string,
  read: (path: string) => Promise<T>,
  deadline = Date.now() + actionTimeoutMs(),
): Promise<T> {
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("App installation timed out.");
    return ms;
  };
  const snapshot = await queueUploadAsync(async () => {
    remaining();
    for (const [directory, size] of failedSnapshotCleanup) {
      try {
        await removeUploadTreeAsync(directory);
      } catch {
        throw new Error(
          "Previous app files still need cleanup. Retry the install or check the host logs.",
        );
      }
      failedSnapshotCleanup.delete(directory);
      snapshotBytes -= size;
      remaining();
    }
    const source = stagedUploadPath(uploadId);
    const info = await lstat(source);
    if (!info.isFile() && !info.isDirectory())
      throw new Error("App uploads must be regular files or app directories.");
    let size = 0,
      entries = 0;
    const links = new Map<string, AppSourceLink>();
    const paths = new Map<string, boolean>();
    const measure = async (path: string, info: Stats): Promise<void> => {
      remaining();
      size += info.size;
      paths.set(relative(source, path), info.isDirectory());
      if (++entries > MAX_SNAPSHOT_ENTRIES)
        throw new Error("App installation source has too many entries.");
      if (snapshotBytes + size > MAX_UPLOAD_DIR_BYTES)
        throw new Error("App installation staging is full. Retry after another install finishes.");
      if (info.isDirectory()) {
        for await (const entry of await opendir(path)) {
          const child = join(path, entry.name);
          await measure(child, await lstat(child));
        }
      } else if (info.isSymbolicLink()) {
        const target = await readlink(path);
        links.set(relative(source, path), { target });
      } else if (!info.isFile())
        throw new Error("App installation source contains an unsupported entry.");
    };
    await measure(source, info);
    for (const link of links.keys()) resolveAppSourceLink(link, paths, links, remaining);
    snapshotBytes += size;
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(UPLOAD_DIR, `${SNAPSHOT_PREFIX}${deadline}-`));
      const path = join(directory, info.isDirectory() ? "source.app" : "source");
      const copied = await runInvocation({
        file: "cp",
        args: ["-R", "-P", source, path],
        timeoutMs: remaining(),
      });
      if (copied.timedOut) throw new Error("App installation timed out.");
      if (copied.exitCode !== 0)
        throw new Error(copied.stderr || "Could not snapshot app installation source.");
      return { path, size, directory };
    } catch (error) {
      if (directory) await removeSnapshotAsync(directory, size);
      else snapshotBytes -= size;
      throw error;
    }
  });
  try {
    return await read(snapshot.path);
  } finally {
    await removeSnapshotAsync(snapshot.directory, snapshot.size);
  }
}

export async function appendUploadChunkAsync(p: {
  uploadId: string;
  data: string;
  first?: boolean;
}): Promise<HostActionResult> {
  const target = stagedUploadPath(p.uploadId);
  const chunk = Buffer.from(p.data, "base64");
  return await queueUploadAsync(async () => {
    await ensurePrivateDirAsync(UPLOAD_DIR);
    // Every chunk: appendFile creates the file too, so omitting `first` would skip the ceiling.
    // The ceiling covers every server's folder; only writes within this process are serialized, so
    // servers that append at the same moment can each pass it by one chunk. A cross-process lock
    // would leave a stale lock behind a crashed server, which costs more than a few MiB of overshoot.
    const held = await pruneStagingAsync();
    if (held + chunk.length > MAX_UPLOAD_DIR_BYTES) {
      return {
        stdout: "",
        stderr:
          `The upload staging area is full (over ${Math.floor(MAX_UPLOAD_DIR_BYTES / 1024 ** 3)}GB). ` +
          `Uploads are removed after ${MAX_UPLOAD_AGE_MS / 3_600_000} hours; retry once the ` +
          "transfers in flight finish.",
        exitCode: 1,
      };
    }
    if (p.first === true) await writeFile(target, chunk);
    else await appendFile(target, chunk);
    return ok(target);
  });
}

export async function removeUploadAsync(uploadId: string): Promise<HostActionResult> {
  return queueUploadAsync(async () => {
    await removeUploadTreeAsync(stagedUploadPath(uploadId));
    return ok();
  });
}

/** Staged beside the uploads so the prune reclaims it if the caller dies before its own cleanup. */
export async function reserveThumbnailPathAsync(): Promise<string> {
  await ensurePrivateDirAsync(UPLOAD_DIR);
  return join(UPLOAD_DIR, `thumb-${randomUUID()}.png`);
}
