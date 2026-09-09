import {
  closeSync,
  constants,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { rmdir as rmdirAsync, unlink as unlinkAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_STABLE_READ_ATTEMPTS = 3;
const DEFAULT_CLEANUP_ATTEMPTS = 5;
const DEFAULT_CLEANUP_RETRY_MS = 20;
const TRANSIENT_CLEANUP_CODES = new Set([
  "EACCES",
  "EBUSY",
  "ENOTEMPTY",
  "EPERM",
]);

/** Matches the encoder's defensive raw-frame ceiling. */
export const MAX_GRPC_MMAP_REGION_BYTES = 512 * 1024 * 1024;

export type StableMmapRead = {
  /** An owned snapshot, or null when every attempt observed a changing region. */
  image: Buffer | null;
  /** Complete candidate/verification read pairs performed. */
  attempts: number;
  /** Bytes copied from the mmap-backed file, including verification reads. */
  bytesRead: number;
  /** Wall-clock time spent reading and comparing the region. */
  readMs: number;
};

type PositionalRead = (
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => number;

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function errorCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return null;
}

/** Tolerate emulator-owned deletion and short Windows mapping-release races. */
export async function retryMmapCleanupOperation(
  operation: () => Promise<void>,
  options: {
    maxAttempts?: number;
    retryDelayMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<void> {
  const maxAttempts = positiveSafeInteger(
    options.maxAttempts ?? DEFAULT_CLEANUP_ATTEMPTS,
    "cleanup maxAttempts",
  );
  const retryDelayMs = positiveSafeInteger(
    options.retryDelayMs ?? DEFAULT_CLEANUP_RETRY_MS,
    "cleanup retryDelayMs",
  );
  const sleep = options.sleep ?? ((delayMs) => delay(delayMs));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await operation();
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return;
      if (
        !code ||
        !TRANSIENT_CLEANUP_CODES.has(code) ||
        attempt === maxAttempts
      )
        throw error;
      await sleep(retryDelayMs * 2 ** (attempt - 1));
    }
  }
}

export function rgb888MmapRegionBytes(width: number, height: number): number {
  positiveSafeInteger(width, "mmap width");
  positiveSafeInteger(height, "mmap height");
  const bytes = width * height * 3;
  if (!Number.isSafeInteger(bytes) || bytes > MAX_GRPC_MMAP_REGION_BYTES) {
    throw new RangeError(
      `gRPC screenshot mmap region must not exceed ${MAX_GRPC_MMAP_REGION_BYTES} bytes`,
    );
  }
  return bytes;
}

function readExactly(
  target: Buffer,
  byteLength: number,
  read: PositionalRead,
): number {
  let offset = 0;
  while (offset < byteLength) {
    const bytesRead = read(target, offset, byteLength - offset, offset);
    if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0) {
      throw new Error(
        `could not read complete gRPC screenshot mmap frame (${offset}/${byteLength} bytes)`,
      );
    }
    offset += bytesRead;
  }
  return offset;
}

/**
 * Copy a coherent best-effort snapshot from the emulator-owned write window.
 *
 * The emulator protocol has no generation word or lock and explicitly permits
 * tearing. Requiring two consecutive positional reads to agree detects a write
 * racing either copy in the common case (the protocol cannot prove coherence
 * if a producer pauses mid-write). A changing region is retried a bounded
 * number of times and then dropped instead of knowingly feeding a torn frame
 * to ffmpeg.
 */
export function readStableMmapFrame(options: {
  byteLength: number;
  verificationBuffer: Buffer;
  read: PositionalRead;
  maxAttempts?: number;
  now?: () => number;
}): StableMmapRead {
  const byteLength = positiveSafeInteger(
    options.byteLength,
    "frame byteLength",
  );
  if (
    !Buffer.isBuffer(options.verificationBuffer) ||
    options.verificationBuffer.length < byteLength
  ) {
    throw new RangeError(
      `verification buffer must hold at least ${byteLength} bytes`,
    );
  }
  const maxAttempts = positiveSafeInteger(
    options.maxAttempts ?? DEFAULT_STABLE_READ_ATTEMPTS,
    "maxAttempts",
  );
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const candidate = Buffer.allocUnsafe(byteLength);
  const verification = options.verificationBuffer.subarray(0, byteLength);
  let bytesRead = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    bytesRead += readExactly(candidate, byteLength, options.read);
    bytesRead += readExactly(verification, byteLength, options.read);
    if (candidate.equals(verification)) {
      return {
        image: candidate,
        attempts: attempt,
        bytesRead,
        readMs: Math.max(0, now() - startedAt),
      };
    }
  }

  return {
    image: null,
    attempts: maxAttempts,
    bytesRead,
    readMs: Math.max(0, now() - startedAt),
  };
}

/** Client-owned file region handed to ImageFormat.transport.handle. */
export class GrpcMmapScreenshotRegion {
  readonly path: string;
  readonly handle: string;
  readonly byteLength: number;
  #fd: number;
  #verificationBuffer = Buffer.alloc(0);
  #closed = false;
  #closeTask: Promise<void> | null = null;

  private constructor(
    readonly directory: string,
    path: string,
    fd: number,
    byteLength: number,
  ) {
    this.path = path;
    // AEMU's POSIX implementation strips the literal `file://` prefix; it does
    // not URL-decode percent escapes. Decode Node's URL so spaces, `%`, and
    // other valid path characters still identify the file the client owns.
    this.handle = decodeURIComponent(pathToFileURL(path).href);
    this.#fd = fd;
    this.byteLength = byteLength;
  }

  static create(byteLength: number): GrpcMmapScreenshotRegion {
    positiveSafeInteger(byteLength, "mmap region byteLength");
    if (byteLength > MAX_GRPC_MMAP_REGION_BYTES) {
      throw new RangeError(
        `gRPC screenshot mmap region must not exceed ${MAX_GRPC_MMAP_REGION_BYTES} bytes`,
      );
    }
    const directory = mkdtempSync(join(tmpdir(), "serve-emu-grpc-mmap-"));
    const path = join(directory, "frame.rgb");
    let fd: number | null = null;
    try {
      fd = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
        0o600,
      );
      ftruncateSync(fd, byteLength);
      return new GrpcMmapScreenshotRegion(directory, path, fd, byteLength);
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
      }
      try {
        unlinkSync(path);
      } catch {}
      try {
        rmdirSync(directory);
      } catch {}
      throw error;
    }
  }

  readFrame(byteLength: number): StableMmapRead {
    if (this.#closed) {
      throw new Error("gRPC screenshot mmap region is closed");
    }
    positiveSafeInteger(byteLength, "frame byteLength");
    if (byteLength > this.byteLength) {
      throw new RangeError(
        `gRPC screenshot frame needs ${byteLength} mmap bytes, region has ${this.byteLength}`,
      );
    }
    if (this.#verificationBuffer.length < byteLength) {
      this.#verificationBuffer = Buffer.allocUnsafe(byteLength);
    }
    return readStableMmapFrame({
      byteLength,
      verificationBuffer: this.#verificationBuffer,
      read: (buffer, offset, length, position) =>
        readSync(this.#fd, buffer, offset, length, position),
    });
  }

  /** Close and remove the client-owned region. Idempotent. */
  close(): Promise<void> {
    if (this.#closeTask) return this.#closeTask;
    this.#closed = true;
    this.#verificationBuffer = Buffer.alloc(0);
    this.#closeTask = (async () => {
      let failure: unknown = null;
      try {
        closeSync(this.#fd);
      } catch (error) {
        failure = error;
      }
      try {
        await retryMmapCleanupOperation(() => unlinkAsync(this.path));
      } catch (error) {
        failure ??= error;
      }
      try {
        await retryMmapCleanupOperation(() => rmdirAsync(this.directory));
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
    })();
    return this.#closeTask;
  }
}
