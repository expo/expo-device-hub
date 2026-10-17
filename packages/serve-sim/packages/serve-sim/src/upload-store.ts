import { randomUUID } from "crypto";
import { appendFile, readdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { z } from "zod";

import {
  type HostActionResult,
  createSerialQueue,
  ensurePrivateDirAsync,
  ok,
  pruneStaleEntriesAsync,
} from "./host-actions-utils";
import { UPLOAD_DIR, UPLOAD_ROOT } from "./host-paths";

// Without a ceiling a caller could fill the disk, and a closed tab never cleans up after itself.
const MAX_UPLOAD_DIR_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_UPLOAD_AGE_MS = 6 * 60 * 60 * 1000;
// Serialized so the budget check and the write cannot interleave: concurrent callers would
// otherwise all read the same pre-write total and sail past the ceiling.
const queueUploadAsync = createSerialQueue();

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
    held += await pruneStaleEntriesAsync(full, MAX_UPLOAD_AGE_MS);
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

/** Hold the staging queue while a reader captures bytes, excluding reset, prune and removal. */
// @ref LLP 0003#uploading-an-app-fixture — resets, pruning and removals wait while a copy reads its source
export function readStagedUploadAsync<T>(
  uploadId: string,
  read: (path: string) => Promise<T>,
): Promise<T> {
  return queueUploadAsync(() => read(stagedUploadPath(uploadId)));
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
    await rm(stagedUploadPath(uploadId), { force: true });
    return ok();
  });
}

/** Staged beside the uploads so the prune reclaims it if the caller dies before its own cleanup. */
export async function reserveThumbnailPathAsync(): Promise<string> {
  await ensurePrivateDirAsync(UPLOAD_DIR);
  return join(UPLOAD_DIR, `thumb-${randomUUID()}.png`);
}
