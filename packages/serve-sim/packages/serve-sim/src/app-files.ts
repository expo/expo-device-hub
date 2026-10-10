import { constants } from "fs";
import { lstat, open, opendir, unlink } from "fs/promises";
import { join, resolve } from "path";
import { z } from "zod";
import { ConfinedPath } from "./host-paths";
import { ok, redactHostPaths, runInvocation, type HostActionResult } from "./host-actions-utils";
import { withLaunchStateLock } from "./launch-state-lock";

export const AppRelativePath = z.string().min(1).max(1024)
  .refine((value) => !/[\\\p{Cc}]/u.test(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "must be a relative app path without traversal or empty components");

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LIST_ENTRIES = 1000;
type Operation = "read" | "list" | "remove";

/** Check every component; callers keep the app stopped and its directories stable. */
async function appPath(root: string, relativePath: string | undefined): Promise<string> {
  const parts = relativePath?.split("/") ?? [];
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const parent = index < parts.length - 1;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("symbolic links are not allowed in app file paths");
      if (parent && !info.isDirectory()) throw new Error("app file parent is not a directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent) throw error;
    }
  }
  return current;
}

async function readBounded(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("app files must be regular files of at most 8 MiB");
    // Bound the read too: a staged upload can still grow after stat.
    const data = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < data.length) {
      const { bytesRead } = await file.read(data, count, data.length - count, null);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count > info.size) throw new Error("file changed while reading; finish the upload and retry");
    return data.subarray(0, count);
  } finally {
    await file.close();
  }
}

export async function runAppFileAction(operation: Operation, p: {
  udid: string; bundleId: string; relativePath?: string;
}): Promise<HostActionResult> {
  return withLaunchStateLock(p.udid, async () => {
    const container = await runInvocation({ file: "xcrun", args: ["simctl", "get_app_container", p.udid, p.bundleId, "data"] });
    if (container.exitCode !== 0) return container;
    try {
      const containerPath = resolve(container.stdout.trim());
      const root = ConfinedPath.parse(containerPath);
      // @ref LLP 0003#app-data-files — unlike general host confinement, links in the container root are refused
      if (root !== containerPath) throw new Error("app data container path contains a symbolic link");
      if (!(await lstat(root)).isDirectory()) throw new Error("app data container is not a directory");
      const target = await appPath(root, p.relativePath);
      if (operation === "list") {
        const entries: { name: string; type: string }[] = [];
        const directory = await opendir(target);
        for await (const entry of directory) {
          if (entries.length === MAX_LIST_ENTRIES) throw new Error("directory has more than 1000 entries");
          entries.push({ name: entry.name,
            type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
          });
        }
        return ok(JSON.stringify(entries));
      }
      if (operation === "read") return ok((await readBounded(target)).toString("base64"));
      if (!(await lstat(target)).isFile()) throw new Error("only regular app files can be removed");
      await unlink(target);
      return ok();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { stdout: "", stderr: code ? `App file operation failed (${code}).` : "App file operation refused: invalid container, path, file type, or file size.", exitCode: 1 };
    }
  }).catch((error) => ({
    stdout: "",
    stderr: redactHostPaths(error instanceof Error ? error.message : String(error)),
    exitCode: 1,
  }));
}
