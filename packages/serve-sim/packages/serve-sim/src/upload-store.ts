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
export const UploadChunk = z.base64().min(1).max(4 * 1024 * 1024);

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

/** Removes folders of servers that exited, and old files that earlier versions staged in the root. */
async function pruneAbandonedStagingAsync(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(UPLOAD_ROOT);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(UPLOAD_ROOT, entry);
    if (full === UPLOAD_DIR) continue;
    const owner = SERVER_FOLDER.exec(entry);
    if (owner && !isRunning(Number(owner[1]))) await rm(full, { recursive: true, force: true }).catch(() => {});
  }
  await pruneStaleEntriesAsync(UPLOAD_ROOT, MAX_UPLOAD_AGE_MS, (entry) => !SERVER_FOLDER.test(entry));
}

export function stagedUploadPath(uploadId: string): string {
  return join(UPLOAD_DIR, uploadId);
}

/** Hold the staging queue while a reader captures bytes, excluding reset, prune and removal. */
// @ref LLP 0003#uploading-an-app-fixture — resets, pruning and removals wait while a copy reads its source
export function readStagedUploadAsync<T>(uploadId: string, read: (path: string) => Promise<T>): Promise<T> {
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
    if (p.first === true) await pruneAbandonedStagingAsync();
    // Every chunk: appendFile creates the file too, so omitting `first` would skip the ceiling.
    const held = await pruneStaleEntriesAsync(UPLOAD_DIR, MAX_UPLOAD_AGE_MS);
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
