import {
  iterableToStream,
  streamToAsyncIterable,
  tar,
  TarChunk,
  TarFile,
  TarTypeFlag,
} from "multitars";

// The browser exposes file contents, but not POSIX modes or symlink metadata.
export interface AppFolderEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?: (ok: (file: File) => void, fail: (error: DOMException) => void) => void;
  createReader?: () => {
    readEntries: (
      ok: (entries: AppFolderEntry[]) => void,
      fail: (error: DOMException) => void,
    ) => void;
  };
}

export const APP_FOLDER_GUIDANCE =
  "Drop a Simulator .app folder or a .tar.gz/.tgz archive. If the folder cannot be read, use an archive to preserve its links and permissions.";

const LIMITS = { entries: 100000, bytes: 2 * 1024 ** 3 };
const encoder = new TextEncoder();

function folderReadError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "Could not read app folder";
  return new Error(`${message}\n${APP_FOLDER_GUIDANCE}`, { cause: error });
}

async function readFolder<T>(read: () => T | Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw folderReadError(error);
  }
}

async function* fileContents(file: File) {
  try {
    yield* streamToAsyncIterable(file.stream());
  } catch (error) {
    throw folderReadError(error);
  }
}

function component(name: string): string {
  if (!name || name === "." || name === ".." || /[/\\]/.test(name) || name.includes("\0"))
    throw new Error("App folder contains an unsafe path");
  return name;
}

async function fileMode(file: File): Promise<number> {
  const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const magic = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const executable =
    (bytes[0] === 35 && bytes[1] === 33) ||
    /^(feedface|feedfacf|cefaedfe|cffaedfe|cafebabe|bebafeca|cafebabf|bfbafeca)$/.test(magic);
  return executable ? 0o700 : 0o600;
}

// @ref LLP 0003#installing-a-simulator-app — bounded browser packing shares the host install policy
export async function packAppFolder(
  entry: AppFolderEntry,
  onProgress: (fraction: number) => void,
  limits = LIMITS,
): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
  if (!entry.isDirectory || !/\.app$/i.test(entry.name)) throw new Error(APP_FOLDER_GUIDANCE);
  const pending = [{ entry, path: component(entry.name).replace(/\.app$/i, ".app") }];
  const items: Array<{ path: string; file?: File }> = [];
  const names = new Set<string>();
  let bytes = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (encoder.encode(next.path).length > 4096 || names.has(next.path))
      throw new Error("App folder contains an invalid or duplicate path");
    names.add(next.path);
    if (names.size > limits.entries)
      throw new Error("App folder has too many entries (max 100000)");
    if (next.entry.isDirectory && next.entry.createReader) {
      items.push({ path: next.path });
      const reader = await readFolder(() => next.entry.createReader!());
      for (;;) {
        const batch = await readFolder(
          () =>
            new Promise<AppFolderEntry[]>((resolve, reject) => reader.readEntries(resolve, reject)),
        );
        if (!batch.length) break;
        if (names.size + pending.length + batch.length > limits.entries)
          throw new Error("App folder has too many entries (max 100000)");
        for (const child of batch)
          pending.push({ entry: child, path: `${next.path}/${component(child.name)}` });
      }
    } else if (next.entry.isFile && next.entry.file) {
      const file = await readFolder(
        () => new Promise<File>((resolve, reject) => next.entry.file!(resolve, reject)),
      );
      bytes += file.size;
      if (!Number.isSafeInteger(bytes) || bytes > limits.bytes)
        throw new Error("App folder is too large (max 2GB before compression)");
      items.push({ path: next.path, file });
    } else {
      throw new Error(APP_FOLDER_GUIDANCE);
    }
  }

  let read = 0;
  let reportedPercent = 0;
  async function* entries() {
    for (const item of items) {
      if (!item.file) {
        yield new TarChunk([], {
          name: item.path,
          mode: 0o700,
          uid: 0,
          gid: 0,
          size: 0,
          mtime: 0,
          typeflag: TarTypeFlag.DIRECTORY,
          linkname: null,
          uname: null,
          gname: null,
          devmajor: 0,
          devminor: 0,
        });
      } else {
        const file = item.file;
        const mode = await readFolder(() => fileMode(file));
        const stream = iterableToStream(fileContents(file)).pipeThrough(
          new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
            transform(chunk, controller) {
              read += chunk.byteLength;
              if (read > limits.bytes) throw new Error("App folder exceeds its size limit");
              const fraction = bytes ? read / bytes : 1;
              const percent = Math.floor(fraction * 100);
              if (percent !== reportedPercent) {
                reportedPercent = percent;
                onProgress(fraction);
              }
              controller.enqueue(chunk);
            },
          }),
        );
        const part = TarFile.from(stream, item.path, {
          size: file.size,
          lastModified: file.lastModified,
        });
        part.mode = mode;
        yield part;
      }
    }
  }
  return iterableToStream(tar(entries())).pipeThrough(new CompressionStream("gzip"));
}
