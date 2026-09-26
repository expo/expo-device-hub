import { openSync, readSync, closeSync } from "fs";
import { resolve } from "path";

export type CamSourceKind = "placeholder" | "webcam" | "image" | "video" | "stream";

export interface ResolvedSource { kind: CamSourceKind; arg?: string }

// Uploaded files can lack an extension, so fall back to their file signature.
const VIDEO_EXTS = new Set([
  "mp4", "m4v", "mov", "qt", "avi", "mkv", "webm", "mpg", "mpeg",
  "3gp", "3g2", "ts", "wmv",
]);
const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "heic", "heif", "webp", "bmp", "tif", "tiff",
]);

export function detectMediaKind(filePath: string): "image" | "video" | null {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (IMAGE_EXTS.has(ext)) return "image";

  // Magic-byte sniff — covers files renamed without an extension, plus
  // common containers we didn't enumerate above. Read a 16-byte header.
  let header: Buffer;
  try {
    const fd = openSync(filePath, "r");
    try {
      header = Buffer.alloc(16);
      const length = readSync(fd, header, 0, header.length, 0);
      header = header.subarray(0, length);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  // ISO base media: bytes 4..8 are an "ftyp" box. Catches mp4/mov/m4v/3gp.
  if (header.length >= 8 && header.slice(4, 8).toString("ascii") === "ftyp") {
    return "video";
  }
  // RIFF (WebP / AVI). WEBP / AVI distinguishes via bytes 8..12.
  if (header.slice(0, 4).toString("ascii") === "RIFF" && header.length >= 12) {
    const tag = header.slice(8, 12).toString("ascii");
    if (tag === "AVI ") return "video";
    if (tag === "WEBP") return "image";
  }
  // Matroska / WebM EBML.
  if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) {
    return "video";
  }
  // PNG.
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) {
    return "image";
  }
  // JPEG.
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image";
  // GIF.
  if (header.slice(0, 6).toString("ascii").startsWith("GIF8")) return "image";
  // BMP.
  if (header[0] === 0x42 && header[1] === 0x4d) return "image";
  return null;
}

export function resolveSourceArg(opts: {
  file?: string;
  webcam?: string | true;
  stream?: boolean;
}): ResolvedSource {
  if (opts.stream) return { kind: "stream" };
  if (opts.file) {
    const abs = resolve(opts.file);
    const kind = detectMediaKind(abs);
    if (!kind) {
      throw new Error(`Could not detect image/video type for: ${abs}`);
    }
    return { kind, arg: abs };
  }
  if (opts.webcam) {
    return { kind: "webcam", arg: typeof opts.webcam === "string" ? opts.webcam : undefined };
  }
  return { kind: "placeholder" };
}
