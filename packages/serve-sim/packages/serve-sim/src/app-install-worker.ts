import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  writeSync,
  fchmodSync,
  readSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { join, posix } from "node:path";
import { ReadableStream, DecompressionStream } from "node:stream/web";
import { untar, TarTypeFlag, streamToAsyncIterable } from "multitars";
import { appArchiveHeaders } from "./app-archive-headers";
import { isUnsupportedAppArchive, UNSUPPORTED_INSTALL_FORMAT } from "./app-install-format";
import { resolveAppSourceLink, type AppSourceLink } from "./app-source-links";

const MAX_BYTES = 2 * 1024 ** 3;
const MAX_ENTRIES = 100_000;
type ArchiveLink = AppSourceLink & { name: string };

function safePath(name: string): boolean {
  return (
    name.length > 0 &&
    Buffer.byteLength(name) <= 4096 &&
    !posix.isAbsolute(name) &&
    !name.split("/").includes("..")
  );
}

function findApps(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const path = join(directory, entry.name);
    return entry.name.endsWith(".app") ? [path] : findApps(path);
  });
}

/** Only the killable preparation child calls this, never the serving process. */
// @ref LLP 0003#installing-a-simulator-app — private bounded extraction and contained links
export async function prepareAppInstall(path: string, directory: string): Promise<string> {
  if (isUnsupportedAppArchive(path)) throw new Error(UNSUPPORTED_INSTALL_FORMAT);
  let fd: number;
  try {
    // Check and read the same inode; a FIFO replacement cannot wait for a writer.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    // Preserve simctl's diagnostics for missing direct paths.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw error;
  }
  try {
    const source = fstatSync(fd);
    if (source.isDirectory()) return path;
    if (!source.isFile())
      throw new Error("App install source must be a regular file or .app directory.");
    const header = Buffer.alloc(2);
    if (readSync(fd, header, 0, 2, 0) !== 2 || header[0] !== 0x1f || header[1] !== 0x8b)
      throw new Error(UNSUPPORTED_INSTALL_FORMAT);
    if (source.size > MAX_BYTES) throw new Error("App archive exceeds the compressed size limit.");
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          "Previous app files still need cleanup. Retry the install or check the host logs.",
        );
      throw error;
    }
    const links = new Map<string, ArchiveLink>();
    const names = new Map<string, TarTypeFlag>();
    const paths = new Map<string, boolean>([["", true]]);
    let bytes = 0,
      entries = 0;
    let compressed = 0;
    const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        const chunk = new Uint8Array(Math.min(64 * 1024, source.size - compressed));
        const read = chunk.length ? readSync(fd, chunk, 0, chunk.length, compressed) : 0;
        if (!read) controller.close();
        else {
          compressed += read;
          controller.enqueue(chunk.subarray(0, read));
        }
      },
    });
    const body = input
      .pipeThrough(new DecompressionStream("gzip"))
      .pipeThrough(appArchiveHeaders(MAX_BYTES, MAX_ENTRIES));
    const reader = body.getReader();
    // Let untar finish at the TAR terminator without canceling our reader. Drain
    // the remaining gzip stream below so a bad trailer cannot escape validation.
    const chunks = {
      [Symbol.asyncIterator]() {
        return {
          next: () => reader.read(),
          return: async () => ({ done: true as const, value: undefined }),
        };
      },
    };
    try {
      for await (const entry of untar(chunks)) {
        const name = entry.name;
        if (!safePath(name)) throw new Error("App archive contains an unsafe path.");
        bytes += entry.size;
        if (bytes > MAX_BYTES || ++entries > MAX_ENTRIES)
          throw new Error("App archive exceeds the expanded size limit.");
        const normalized = posix.normalize(name).replace(/\/$/, "").replace(/^\.$/, "");
        const previous = names.get(normalized);
        if (
          previous &&
          !(previous === TarTypeFlag.DIRECTORY && entry.typeflag === TarTypeFlag.DIRECTORY)
        )
          throw new Error("App archive contains conflicting entries.");
        names.set(normalized, entry.typeflag);
        const components = normalized.split("/");
        components.pop();
        while (components.length) {
          const parent = components.join("/");
          if (paths.get(parent) === false)
            throw new Error("App archive contains conflicting entries.");
          paths.set(parent, true);
          components.pop();
        }
        const directoryEntry = entry.typeflag === TarTypeFlag.DIRECTORY;
        if (paths.get(normalized) === true && !directoryEntry)
          throw new Error("App archive contains conflicting entries.");
        paths.set(normalized, directoryEntry);
        const destination = join(directory, normalized);
        if (entry.typeflag === TarTypeFlag.SYMLINK || entry.typeflag === TarTypeFlag.LINK) {
          const target = entry.linkname ?? "";
          if (!target || Buffer.byteLength(target) > 4096 || posix.isAbsolute(target))
            throw new Error("App archive contains an unsafe link.");
          links.set(normalized, {
            name: normalized,
            target,
            hard: entry.typeflag === TarTypeFlag.LINK,
          });
          // Reserve every parent before links exist. Filesystem aliases of a
          // required folder must collide instead of redirecting later writes.
          mkdirSync(posix.dirname(destination), { recursive: true, mode: 0o700 });
          continue;
        }
        if (entry.typeflag === TarTypeFlag.DIRECTORY) {
          mkdirSync(destination, { recursive: true, mode: 0o700 });
          continue;
        }
        mkdirSync(posix.dirname(destination), { recursive: true, mode: 0o700 });
        const mode = (entry.mode & 0o700) | 0o600;
        const output = openSync(
          destination,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          mode,
        );
        try {
          for await (const chunk of streamToAsyncIterable(entry.stream())) {
            let written = 0;
            while (written < chunk.length)
              written += writeSync(output, chunk, written, chunk.length - written);
          }
          fchmodSync(output, mode);
        } finally {
          closeSync(output);
        }
      }
      while (!(await reader.read()).done) {
        /* Validate the gzip trailer within the same stream budget. */
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    for (const name of names.keys()) {
      const parents = name.split("/");
      parents.pop();
      while (parents.length) {
        if (links.has(parents.join("/")))
          throw new Error("App archive contains an entry through a link.");
        parents.pop();
      }
    }
    const targets = new Map<string, string>();
    for (const link of links.values()) {
      const target = resolveAppSourceLink(link.name, paths, links);
      if (link.hard && paths.get(target) !== false)
        throw new Error("App archive contains an unsupported link target.");
      targets.set(link.name, target);
    }
    for (const link of links.values()) {
      const destination = join(directory, link.name);
      try {
        if (link.hard) linkSync(join(directory, targets.get(link.name)!), destination);
        else symlinkSync(link.target, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error("App archive contains conflicting entries.");
        throw error;
      }
    }
    const apps = findApps(directory);
    if (apps.length !== 1) throw new Error("App archive must contain exactly one .app bundle.");
    return apps[0]!;
  } finally {
    closeSync(fd);
  }
}
