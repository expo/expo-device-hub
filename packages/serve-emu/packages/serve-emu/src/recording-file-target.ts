import { open, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { StreamTarget, type StreamTargetChunk } from "mediabunny";

/** Enforces the file extent, including header rewrites and finalization metadata. */
export async function createRecordingFileTarget(options: {
  path: string;
  maxFileBytes: number;
  minFreeBytes: number;
  readFreeBytes?: () => Promise<number>;
}) {
  const readFreeBytes =
    options.readFreeBytes ??
    (async () => {
      const info = await statfs(dirname(options.path));
      return info.bavail * info.bsize;
    });
  let freeBytes = await readFreeBytes();
  if (freeBytes < options.minFreeBytes)
    throw new Error("Recording disk space is below its free-space reserve.");
  const file = await open(options.path, "wx");
  let extent = 0;
  let checkedAt = performance.now();
  let closeTask: Promise<void> | null = null;
  const close = () => (closeTask ??= file.close());
  const target = new StreamTarget(
    new WritableStream<StreamTargetChunk>({
      async write({ data, position }) {
        try {
          const end = position + data.byteLength;
          if (!Number.isSafeInteger(end) || end > options.maxFileBytes) {
            throw new Error("Recording exceeded its file byte limit.");
          }
          if (performance.now() - checkedAt >= 5_000) {
            freeBytes = await readFreeBytes();
            checkedAt = performance.now();
          }
          const growth = Math.max(0, end - extent);
          if (freeBytes - growth < options.minFreeBytes) {
            throw new Error("Recording disk space is below its free-space reserve.");
          }
          let offset = 0;
          while (offset < data.byteLength) {
            const { bytesWritten } = await file.write(
              data,
              offset,
              data.byteLength - offset,
              position + offset,
            );
            if (bytesWritten === 0) throw new Error("Recording file write made no progress.");
            offset += bytesWritten;
          }
          extent = Math.max(extent, end);
          freeBytes -= growth;
        } catch (error) {
          await close();
          throw error;
        }
      },
      close,
      abort: close,
    }),
    // Unchunked, so every closed fragment reaches the disk at once instead of waiting in a buffer.
    { chunked: false },
  );
  return { target, close };
}
