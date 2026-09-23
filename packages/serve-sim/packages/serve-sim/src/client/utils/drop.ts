import { runHostAction } from "./exec";

// ─── File drop (drag media/ipa onto the simulator) ───
//
// Media → `xcrun simctl addmedia`   (Photos)
// .ipa  → `xcrun simctl install`    (install app on simulator)
//
// Files are streamed to the host in base64 chunks over the action channel, which decodes and
// appends each one. No sonner dep here, so uploads surface in an inline toast list.

export const DROP_MEDIA_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
]);

// 192KB of raw bytes per chunk → ~256KB of base64 per frame, well inside the channel's 4MB
// message cap, while sharply cutting round-trips on large .ipa uploads. Each chunk is decoded
// and appended on its own, so chunks are independent of each other.
export const DROP_CHUNK_BYTES = 196608;
export const DROP_MAX_FILE_SIZE = 500 * 1024 * 1024;

// Custom drag flavor carrying a path that already exists on the host (e.g. the
// screenshot pill). Dropping it on the simulator skips the upload and adds the
// file to Photos in place. A non-text MIME type so text editors ignore it.
export const DROP_HOST_PATH_TYPE = "application/x-serve-sim-host-path";

// Add a host-resident image/video straight to Photos — no upload round-trip,
// since the file is already on disk.
export async function addHostMediaToPhotos(path: string, udid: string) {
  const result = await runHostAction("media.add", { udid, path });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `addmedia failed (exit ${result.exitCode})`);
  }
}

export type DropKind = "media" | "ipa";

export function fileExtension(file: File): string {
  const name = file.name;
  const dot = name.lastIndexOf(".");
  if (dot >= 0) return name.slice(dot + 1).toLowerCase();
  if (file.type.startsWith("video/")) return "mp4";
  return "jpg";
}

export function dropKindFor(file: File): DropKind | null {
  if (fileExtension(file) === "ipa") return "ipa";
  if (DROP_MEDIA_MIME_TYPES.has(file.type)) return "media";
  return null;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // 32KB blocks keep fromCharCode's argument count under engine limits while
  // avoiding a per-byte concat loop that stalls the main thread on big files.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// Stream `file` into `tmpPath` one slice at a time. Reading and encoding per
// slice (instead of base64ing the whole file up front) keeps peak memory at
// one chunk regardless of file size and never blocks the main thread long
// enough to stall the simulator stream.
async function streamFileToHost(
  file: File,
  uploadId: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  let hostPath = "";
  let lastReportedPct = 0;
  for (let offset = 0; offset < file.size; offset += DROP_CHUNK_BYTES) {
    const slice = await file.slice(offset, offset + DROP_CHUNK_BYTES).arrayBuffer();
    const chunk = arrayBufferToBase64(slice);
    const result = await runHostAction("upload.append", {
      uploadId,
      data: chunk,
      first: offset === 0,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Write failed (exit ${result.exitCode})`);
    }
    hostPath = result.stdout.trim();
    if (!onProgress) continue;
    const written = Math.min(offset + DROP_CHUNK_BYTES, file.size);
    const pct = Math.floor((written / file.size) * 100);
    if (pct !== lastReportedPct) {
      lastReportedPct = pct;
      onProgress(written / file.size);
    }
  }
  return hostPath;
}

// Stream a file to the host upload directory in base64 chunks. Used by the camera
// panel to stage image/video sources for `serve-sim camera --file`.
// Caller is responsible for the lifetime of the temp file.
export async function uploadFileToTmp(file: File, prefix: string, ext: string): Promise<string> {
  if (file.size > DROP_MAX_FILE_SIZE) {
    throw new Error("File too large (max 500MB)");
  }
  return await streamFileToHost(file, `${prefix}-${crypto.randomUUID()}.${ext}`);
}

export async function uploadDroppedFile(
  file: File,
  kind: DropKind,
  udid: string,
  onProgress: (progress: number | null) => void,
) {
  if (file.size > DROP_MAX_FILE_SIZE) {
    throw new Error("File too large (max 500MB)");
  }

  const ext = kind === "ipa" ? "ipa" : fileExtension(file);
  const prefix = kind === "ipa" ? "serve-sim-install" : "serve-sim-upload";
  const uploadId = `${prefix}-${crypto.randomUUID()}.${ext}`;

  try {
    onProgress(0);
    await streamFileToHost(file, uploadId, onProgress);

    // install/addmedia gives no progress signal — flip to indeterminate.
    onProgress(null);
    const result = await runHostAction(kind === "ipa" ? "app.install" : "media.add", {
      udid,
      uploadId,
    });
    if (result.exitCode !== 0) {
      const label = kind === "ipa" ? "install" : "addmedia";
      throw new Error(result.stderr || `${label} failed (exit ${result.exitCode})`);
    }
  } finally {
    void runHostAction("upload.remove", { uploadId }).catch(() => {});
  }
}
