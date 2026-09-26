import { closeSync, constants, openSync, rmSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";

// Capture files can land in a folder someone else can write, such as a shared `capture har -o`
// target. These flags make a symlink planted at the path fail the write instead of redirecting it.
const NO_FOLLOW = constants.O_NOFOLLOW;
export const WRITE_NO_FOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NO_FOLLOW;
export const APPEND_NO_FOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NO_FOLLOW;

export function writeFileNoFollow(path: string, data: string): void {
  const fd = openSync(path, WRITE_NO_FOLLOW);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

export function appendFileNoFollowSync(path: string, data: string): void {
  const fd = openSync(path, APPEND_NO_FOLLOW);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

// fs.promises.appendFile ignores a numeric flag under Bun, so open the file directly.
export async function appendFileNoFollow(path: string, data: string): Promise<void> {
  const handle = await open(path, APPEND_NO_FOLLOW);
  try {
    await handle.write(data);
  } finally {
    await handle.close();
  }
}

/**
 * Clear a temp path before it is created with the exclusive "wx" flag. Removing a link removes the
 * link, not its target, and "wx" then refuses anything that reappears there.
 */
export function clearTempPath(path: string): void {
  rmSync(path, { force: true });
}
