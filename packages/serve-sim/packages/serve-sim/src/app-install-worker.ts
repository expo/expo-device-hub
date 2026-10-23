import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { join, posix } from "node:path";
import { UnpackSync } from "tar";
import { isUnsupportedAppArchive, UNSUPPORTED_INSTALL_FORMAT } from "./app-install-format";

const MAX_BYTES = 2 * 1024 ** 3;
const MAX_ENTRIES = 100_000;
type ArchiveLink = { name: string; target: string; hard: boolean };

function safePath(name: string): boolean {
  return (
    name.length > 0 &&
    Buffer.byteLength(name) <= 4096 &&
    !posix.isAbsolute(name) &&
    !name.split("/").includes("..")
  );
}

/** Resolve every link component without opening a target outside the extraction root. */
function resolveLink(name: string, links: Map<string, ArchiveLink>): string {
  const parts = name.split("/");
  const resolved: string[] = [];
  let hops = 0;
  while (parts.length) {
    const part = parts.shift()!;
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!resolved.length) throw new Error("App archive contains an unsafe link.");
      resolved.pop();
      continue;
    }
    resolved.push(part);
    const link = links.get(resolved.join("/"));
    if (!link) continue;
    if (++hops > 40) throw new Error("App archive contains a cyclic or excessive link chain.");
    resolved.pop();
    if (link.hard) resolved.length = 0;
    parts.unshift(...link.target.split("/"));
  }
  return resolved.join("/");
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
export function prepareAppInstall(path: string, directory: string): string {
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
    const names = new Map<string, string>();
    let bytes = 0,
      entries = 0;
    const unpack = new UnpackSync({
      cwd: directory,
      strict: true,
      preservePaths: false,
      chmod: true,
      maxDecompressionRatio: 2048,
      filter(name, entry) {
        if (!safePath(name)) throw new Error("App archive contains an unsafe path.");
        if (
          !("type" in entry) ||
          !["File", "Directory", "SymbolicLink", "Link"].includes(entry.type)
        )
          throw new Error("App archive contains an unsupported entry.");
        bytes += entry.size;
        if (bytes > MAX_BYTES || ++entries > MAX_ENTRIES)
          throw new Error("App archive exceeds the expanded size limit.");
        const normalized = posix.normalize(name).replace(/\/$/, "");
        const previous = names.get(normalized);
        if (previous && !(previous === "Directory" && entry.type === "Directory"))
          throw new Error("App archive contains conflicting entries.");
        names.set(normalized, entry.type);
        entry.mode = entry.type === "Directory" ? 0o700 : ((entry.mode ?? 0) & 0o700) | 0o600;
        if (entry.type !== "SymbolicLink" && entry.type !== "Link") return true;
        const target = entry.linkpath ?? "";
        if (!target || Buffer.byteLength(target) > 4096 || posix.isAbsolute(target))
          throw new Error("App archive contains an unsafe link.");
        links.set(normalized, { name: normalized, target, hard: entry.type === "Link" });
        return false;
      },
    });
    // No asynchronous writes survive a rejected entry. The parent can kill this
    // process if IO or decompression stops progressing.
    const chunk = Buffer.alloc(64 * 1024);
    let read: number;
    while ((read = readSync(fd, chunk, 0, chunk.length, null)) > 0)
      unpack.write(chunk.subarray(0, read));
    unpack.end();
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
      const target = resolveLink(link.name, links);
      const info = lstatSync(join(directory, target));
      if (link.hard ? !info.isFile() : !(info.isFile() || info.isDirectory()))
        throw new Error("App archive contains an unsupported link target.");
      targets.set(link.name, target);
    }
    for (const link of links.values()) {
      const destination = join(directory, link.name);
      mkdirSync(posix.dirname(destination), { recursive: true, mode: 0o700 });
      if (link.hard) linkSync(join(directory, targets.get(link.name)!), destination);
      else symlinkSync(link.target, destination);
    }
    const apps = findApps(directory);
    if (apps.length !== 1) throw new Error("App archive must contain exactly one .app bundle.");
    return apps[0]!;
  } finally {
    closeSync(fd);
  }
}
