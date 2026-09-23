import { randomUUID } from "crypto";
import { appendFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { z } from "zod";

import {
  type HostActionResult,
  createSerialQueue,
  ensurePrivateDirAsync,
  ok,
  pruneStaleEntriesAsync,
} from "./host-actions-utils";
import { UPLOAD_DIR } from "./host-paths";

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

export function stagedUploadPath(uploadId: string): string {
  return join(UPLOAD_DIR, uploadId);
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
  await rm(stagedUploadPath(uploadId), { force: true });
  return ok();
}

/** Staged beside the uploads so the prune reclaims it if the caller dies before its own cleanup. */
export async function reserveThumbnailPathAsync(): Promise<string> {
  await ensurePrivateDirAsync(UPLOAD_DIR);
  return join(UPLOAD_DIR, `thumb-${randomUUID()}.png`);
}
