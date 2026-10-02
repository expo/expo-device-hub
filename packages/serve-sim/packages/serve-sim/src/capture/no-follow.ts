import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

// Capture files can land in a folder someone else can write, such as a shared `capture har -o`
// target. These flags make a symlink planted at the path fail the write instead of redirecting it.
const NO_FOLLOW = constants.O_NOFOLLOW;
export const WRITE_NO_FOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NO_FOLLOW;
const STAGE_NO_FOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;
export const APPEND_NO_FOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NO_FOLLOW;
// Capture files hold decrypted traffic, so they are created readable by their owner only rather
// than with whatever the process umask allows. A file that already exists, such as a HAR being
// recorded over, is set to the same mode once it is open, before anything is written to it.
export const OWNER_ONLY_FILE = 0o600;

export type SyncWriter = (fd: number, data: string) => void;
export type AsyncWriter = (handle: FileHandle, data: string) => Promise<void>;

type ChunkWriterSync = (fd: number, buffer: Buffer, offset: number, length: number) => number;
type ChunkWriter = (handle: FileHandle, buffer: Buffer, offset: number, length: number) => Promise<number>;

const writeChunkSync: ChunkWriterSync = (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length);
const writeChunk: ChunkWriter = async (handle, buffer, offset, length) =>
  (await handle.write(buffer, offset, length)).bytesWritten;

/**
 * A write can accept fewer bytes than it was given; keep writing the rest, so a line is never cut.
 * The data is encoded once, so the offsets never split a multibyte character. `writeChunk` is
 * injectable so a test can accept a few bytes at a time.
 */
export function writeAllSync(fd: number, data: string, write: ChunkWriterSync = writeChunkSync): void {
  const buffer = Buffer.from(data);
  for (let offset = 0; offset < buffer.length; ) {
    const written = write(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error("Capture file write made no progress.");
    offset += written;
  }
}

export async function writeAllAsync(handle: FileHandle, data: string, write: ChunkWriter = writeChunk): Promise<void> {
  const buffer = Buffer.from(data);
  for (let offset = 0; offset < buffer.length; ) {
    const written = await write(handle, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error("Capture file write made no progress.");
    offset += written;
  }
}

export function writeFileNoFollow(path: string, data: string): void {
  const fd = openSync(path, WRITE_NO_FOLLOW, OWNER_ONLY_FILE);
  try {
    fchmodSync(fd, OWNER_ONLY_FILE);
    writeAllSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replace several files together. Each new file is written in full to an exclusive temp file beside
 * its target first; only once every one is written are they renamed into place. A write that fails,
 * such as on a full disk, leaves every existing file as it was (a recording replaced with `--force`
 * is not half wiped). A rename replaces a symlink planted at the path rather than following it.
 */
export function replaceFilesNoFollow(
  // `staged`: a temp file the caller already wrote in full, beside its target; it is renamed like the others.
  files: ReadonlyArray<{ path: string; data: string } | { path: string; staged: string }>,
  write: SyncWriter = (fd, text) => writeAllSync(fd, text),
): void {
  // Checked before any rename, so a refusal leaves every file as it was. A symlink planted at a
  // path is refused, as the other writers refuse it, rather than silently replaced; a folder would
  // make its rename fail after earlier ones already happened.
  for (const { path } of files) {
    let stat: ReturnType<typeof lstatSync> | null = null;
    try {
      stat = lstatSync(path);
    } catch {}
    if (stat?.isSymbolicLink()) throw new Error(`${path} is a symlink, so the recording will not be written there.`);
    if (stat?.isDirectory()) throw new Error(`${path} is a folder, so the recording cannot be written there.`);
  }
  const staged: string[] = [];
  try {
    for (const file of files) {
      if ("staged" in file) {
        staged.push(file.staged);
        continue;
      }
      const { path, data } = file;
      const temp = `${path}.${randomUUID()}.replace.tmp`;
      const fd = openSync(temp, STAGE_NO_FOLLOW, OWNER_ONLY_FILE);
      staged.push(temp);
      try {
        write(fd, data);
      } finally {
        closeSync(fd);
      }
    }
    files.forEach(({ path }, index) => renameSync(staged[index]!, path));
    staged.length = 0;
  } finally {
    for (const temp of staged) {
      try {
        unlinkSync(temp);
      } catch {}
    }
  }
}

/**
 * Append a batch, or leave the file as it was. An append is not atomic: a write that fails part way
 * would leave a split line, and the caller's retry of the whole batch would then duplicate the rest.
 * The file is cut back to its previous length before the error is rethrown. `write` is injectable
 * so a test can fail a write part way.
 */
export function appendFileNoFollowSync(path: string, data: string, write: SyncWriter = (fd, text) => writeAllSync(fd, text)): void {
  const fd = openSync(path, APPEND_NO_FOLLOW, OWNER_ONLY_FILE);
  try {
    fchmodSync(fd, OWNER_ONLY_FILE);
    const before = fstatSync(fd).size;
    try {
      write(fd, data);
    } catch (error) {
      try {
        ftruncateSync(fd, before);
      } catch {
        // The original error is the one to report; the partial line is at least visible in the file.
      }
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}

// fs.promises.appendFile ignores a numeric flag under Bun, so open the file directly.
export async function appendFileNoFollow(path: string, data: string, write: AsyncWriter = (handle, text) => writeAllAsync(handle, text)): Promise<void> {
  const handle = await open(path, APPEND_NO_FOLLOW, OWNER_ONLY_FILE);
  try {
    await handle.chmod(OWNER_ONLY_FILE);
    const before = (await handle.stat()).size;
    try {
      await write(handle, data);
    } catch (error) {
      await handle.truncate(before).catch(() => {});
      throw error;
    }
  } finally {
    await handle.close();
  }
}
