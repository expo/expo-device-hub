/**
 * Still-image camera passthrough for the Android Emulator.
 *
 * The emulator's `-camera-back imagefile:<path>` mode renders a PNG as the
 * camera feed, and it re-reads that file every time the guest opens the camera
 * device. serve-emu therefore points a launch at a stable per-serial path and
 * changes the picture by rewriting the file: no emulator restart, only a camera
 * reopen in the app under test. The path has to be fixed at launch because the
 * emulator exposes no console or gRPC command that re-points a running camera.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { readEmuConsoleValue } from "./adb.ts";
import { isEmulatorSerial } from "./device-capabilities.ts";
import { execText } from "./exec.ts";
import { HttpBodyError, readBodyLimited } from "./request-body.ts";
import {
  CAMERA_FACINGS,
  type CameraFacing,
  type CameraFeedStatus,
  type CameraStatus,
} from "./shared/api-contracts.ts";

export type { CameraFacing, CameraFeedStatus, CameraStatus };

export const MAX_CAMERA_IMAGE_BYTES = 32 * 1024 * 1024;

const DEFAULT_FEED_ROOT = join(homedir(), ".cache", "serve-emu", "camera");

/** Read per call so tests and read-only home directories can redirect it. */
export function cameraFeedRoot(): string {
  return process.env.SERVE_EMU_CAMERA_DIR ?? DEFAULT_FEED_ROOT;
}
const PLACEHOLDER_SIZE = { width: 1280, height: 960 };
const PLACEHOLDER_CELL = 64;
const PLACEHOLDER_DARK: Rgb = [0x1e, 0x22, 0x29];
const PLACEHOLDER_LIGHT: Rgb = [0x49, 0x52, 0x60];
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
/** 4-byte length, 4-byte type, 4-byte CRC. */
const PNG_CHUNK_OVERHEAD_BYTES = 12;

type Rgb = readonly [number, number, number];

/**
 * A camera request the caller can fix: an unknown facing, a body that is not a
 * PNG the emulator can load, a device that has no imagefile camera. Anything
 * else the camera routes throw is this host's fault, and an unwritable or full
 * feed directory must not be reported as bad input.
 */
export class CameraInputError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "CameraInputError";
  }
}

function isCameraFacing(value: unknown): value is CameraFacing {
  return typeof value === "string" && CAMERA_FACINGS.includes(value as CameraFacing);
}

export function parseCameraFacing(value: unknown): CameraFacing {
  if (value === undefined || value === null || value === "") return "back";
  if (!isCameraFacing(value)) {
    throw new CameraInputError(`facing must be one of: ${CAMERA_FACINGS.join(", ")}`);
  }
  return value;
}

function feedFileName(serial: string, facing: CameraFacing): string {
  return `${serial.replace(/[^A-Za-z0-9._-]/g, "_")}-${facing}.png`;
}

export function cameraFeedPath(serial: string, facing: CameraFacing): string {
  return join(cameraFeedRoot(), feedFileName(serial, facing));
}

export function cameraLaunchArgs(serial: string): string[] {
  return CAMERA_FACINGS.flatMap((facing) => [
    `-camera-${facing}`,
    `imagefile:${cameraFeedPath(serial, facing)}`,
  ]);
}

export function assertCameraSupported(serial: string): void {
  if (!isEmulatorSerial(serial)) {
    throw new CameraInputError(
      "camera image passthrough is supported for Android Emulator serials only",
    );
  }
}

export type PngSize = { width: number; height: number };

function readPngSize(bytes: Uint8Array): PngSize {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
    throw new CameraInputError(
      "camera image must be a PNG; the Android emulator imagefile camera loads PNG only",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") {
    throw new CameraInputError("camera image PNG is missing its IHDR header");
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1) {
    throw new CameraInputError("camera image PNG has zero dimensions");
  }
  return { width, height };
}

/**
 * Walk the chunk stream so a file that cannot be decoded is refused here rather
 * than becoming a solid magenta camera frame. Checks structure only, which is
 * what the demonstrated failures are: truncation, a corrupt or missing `IDAT`,
 * and a missing `IEND`. Bit depth, colour type and interlace are left alone
 * because the emulator's loader accepts more of those than is documented, and
 * guessing at an allowlist would reject images it renders fine.
 */
function assertPngChunkStream(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let sawImageData = false;

  while (offset + PNG_CHUNK_OVERHEAD_BYTES <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const end = offset + PNG_CHUNK_OVERHEAD_BYTES + length;
    if (end > bytes.length) {
      throw new CameraInputError(`camera image PNG is truncated inside its ${type} chunk`);
    }
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) {
      throw new CameraInputError(`camera image PNG has a corrupt ${type} chunk`);
    }
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      if (!sawImageData) throw new CameraInputError("camera image PNG has no IDAT chunk");
      return;
    }
    offset = end;
  }

  throw new CameraInputError("camera image PNG is truncated before its IEND chunk");
}

export function assertCameraImage(bytes: Uint8Array): PngSize {
  if (bytes.length > MAX_CAMERA_IMAGE_BYTES) {
    throw new CameraInputError(`camera image exceeds ${MAX_CAMERA_IMAGE_BYTES} bytes`);
  }
  const size = readPngSize(bytes);
  assertPngChunkStream(bytes);
  return size;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Indexed rather than `for..of`: this runs over a whole request body on the
 * event loop that also forwards video frames, and the iterator form measured
 * 3.4x slower over 32MB (325ms against 96ms).
 */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Uint8Array): Buffer {
  const chunk = Buffer.alloc(body.length + 12);
  chunk.writeUInt32BE(body.length, 0);
  chunk.write(type, 4, "ascii");
  chunk.set(body, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + body.length)), 8 + body.length);
  return chunk;
}

function checkerboardScanlines(
  width: number,
  height: number,
  cell: number,
  dark: Rgb,
  light: Rgb,
): Buffer {
  const stride = width * 3 + 1;
  const templates = [Buffer.alloc(stride), Buffer.alloc(stride)];
  for (const [phase, row] of templates.entries()) {
    for (let x = 0; x < width; x += 1) {
      const color = (Math.floor(x / cell) + phase) % 2 === 0 ? dark : light;
      row.set(color, 1 + x * 3);
    }
  }
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw.set(templates[Math.floor(y / cell) % 2]!, y * stride);
  }
  return raw;
}

function encodeTruecolorPng(width: number, height: number, scanlines: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

let placeholderCache: { png: Buffer; digest: string } | null = null;

/** The "no image set" test card. Generated once, so its digest identifies it. */
export function placeholderCameraImage(): { png: Buffer; digest: string } {
  if (!placeholderCache) {
    const png = encodeTruecolorPng(
      PLACEHOLDER_SIZE.width,
      PLACEHOLDER_SIZE.height,
      checkerboardScanlines(
        PLACEHOLDER_SIZE.width,
        PLACEHOLDER_SIZE.height,
        PLACEHOLDER_CELL,
        PLACEHOLDER_DARK,
        PLACEHOLDER_LIGHT,
      ),
    );
    placeholderCache = { png, digest: digestOf(png) };
  }
  return placeholderCache;
}

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Replace the feed file in one step. The emulator falls back to a solid magenta
 * frame whenever it cannot parse the file, so a reader must never observe a
 * partial write. The staging name is unique per write, not per process, so two
 * concurrent writes to one facing cannot interleave into the same file.
 */
async function writeFeedFile(path: string, png: Uint8Array): Promise<void> {
  await mkdir(cameraFeedRoot(), { recursive: true });
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(staging, png);
    await rename(staging, path);
  } catch (error) {
    await unlink(staging).catch(() => {});
    throw error;
  }
}

export async function readCameraFeed(
  serial: string,
  facing: CameraFacing,
): Promise<CameraFeedStatus> {
  const path = cameraFeedPath(serial, facing);
  let bytes: Buffer;
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    [bytes, stats] = await Promise.all([readFile(path), stat(path)]);
  } catch {
    return {
      facing,
      path,
      present: false,
      placeholder: false,
      width: null,
      height: null,
      bytes: null,
      digest: null,
      updatedAt: null,
    };
  }
  const digest = digestOf(bytes);
  let size: PngSize | null = null;
  try {
    size = readPngSize(bytes);
  } catch {
    size = null;
  }
  return {
    facing,
    path,
    present: true,
    placeholder: digest === placeholderCameraImage().digest,
    width: size?.width ?? null,
    height: size?.height ?? null,
    bytes: bytes.byteLength,
    digest,
    updatedAt: stats.mtime.toISOString(),
  };
}

/** Minimal `key = value` reader. The emulator writes one pair per line. */
function iniValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

/**
 * Ask the running emulator whether serve-emu's feeds are its camera source.
 *
 * `hardware-qemu.ini` in the AVD data directory is the effective hardware
 * config the emulator writes at launch, so it merges the static `config.ini`
 * with the launch flags and reports the truth for either wiring route. The
 * serial resolves to that directory through the console at read time, so a
 * recycled serial cannot report an earlier run's wiring, and the answer
 * survives a serve-emu restart. Anything unreadable means unwired.
 */
export async function readCameraWiring(
  serial: string,
  runExec: typeof execText = execText,
): Promise<boolean> {
  if (!isEmulatorSerial(serial)) return false;
  const avdPath = await readEmuConsoleValue(serial, ["avd", "path"], runExec);
  if (!avdPath) return false;
  let config: string;
  try {
    config = await readFile(join(avdPath, "hardware-qemu.ini"), "utf8");
  } catch {
    return false;
  }
  const values = iniValues(config);
  return CAMERA_FACINGS.every(
    (facing) =>
      values.get(`hw.camera.${facing}`) ===
      `imagefile:${cameraFeedPath(serial, facing)}`,
  );
}

/**
 * Whether a camera request is satisfied by the emulator this launch resolved.
 *
 * A launch that spawned the emulator wired the feeds itself. A launch that
 * reattached to a running AVD cannot change its camera source, but that AVD may
 * already carry serve-emu's feeds from an earlier launch, so ask the emulator
 * before refusing. A serve-emu restart, or a second host, therefore keeps using
 * a camera that already works.
 */
export async function cameraLaunchIsWired(
  launch: { serial: string; cameraFeed: boolean },
  readWiring: typeof readCameraWiring = readCameraWiring,
): Promise<boolean> {
  return launch.cameraFeed || (await readWiring(launch.serial));
}

export async function readCameraStatus(
  serial: string,
  readWiring: typeof readCameraWiring = readCameraWiring,
): Promise<CameraStatus> {
  const [wiredAtLaunch, feeds] = await Promise.all([
    readWiring(serial),
    Promise.all(CAMERA_FACINGS.map((facing) => readCameraFeed(serial, facing))),
  ]);
  return {
    serial,
    supported: isEmulatorSerial(serial),
    wiredAtLaunch,
    launchArgs: cameraLaunchArgs(serial),
    feeds,
  };
}

export async function setCameraImage(
  serial: string,
  facing: CameraFacing,
  png: Uint8Array,
): Promise<CameraFeedStatus> {
  assertCameraSupported(serial);
  assertCameraImage(png);
  await writeFeedFile(cameraFeedPath(serial, facing), png);
  return readCameraFeed(serial, facing);
}

export async function clearCameraImage(
  serial: string,
  facing: CameraFacing,
): Promise<CameraFeedStatus> {
  assertCameraSupported(serial);
  await writeFeedFile(cameraFeedPath(serial, facing), placeholderCameraImage().png);
  return readCameraFeed(serial, facing);
}

/** Drop staging files this serial's earlier runs left behind on a crash. */
async function sweepStagingFiles(serial: string): Promise<void> {
  const root = cameraFeedRoot();
  const prefixes = CAMERA_FACINGS.map((facing) => `${feedFileName(serial, facing)}.`);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter(
        (name) =>
          name.endsWith(".tmp") && prefixes.some((prefix) => name.startsWith(prefix)),
      )
      .map((name) => unlink(join(root, name)).catch(() => {})),
  );
}

/**
 * Put every facing in a known state before the emulator starts. Always writes,
 * rather than keeping whatever is on disk: serials are recycled
 * (`emulator-<port>`), and a launch only reaches here when it spawned a fresh
 * emulator, so an existing file belongs to an unrelated earlier run and must
 * not become this app's camera. An absent or unparsable file would render as
 * solid magenta, which reads as a broken camera.
 */
export async function seedCameraFeeds(serial: string): Promise<void> {
  const { png } = placeholderCameraImage();
  await sweepStagingFiles(serial);
  await Promise.all(
    CAMERA_FACINGS.map((facing) =>
      writeFeedFile(cameraFeedPath(serial, facing), png),
    ),
  );
}

export async function readCameraImage(
  serial: string,
  facing: CameraFacing,
): Promise<Buffer | null> {
  try {
    return await readFile(cameraFeedPath(serial, facing));
  } catch {
    return null;
  }
}

/**
 * Serve a feed image without copying it. A feed is up to 32MB, and re-viewing
 * the same memory keeps that off the event loop that also forwards video
 * frames. `readFile` types its buffer over `ArrayBufferLike`, which `BodyInit`
 * refuses, so the view narrows it; a Node buffer never sits on a
 * `SharedArrayBuffer`.
 */
export function cameraImageResponse(png: Uint8Array): Response {
  const bytes = new Uint8Array(
    png.buffer as ArrayBuffer,
    png.byteOffset,
    png.byteLength,
  );
  return new Response(bytes, {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}

export type CameraRequestContext = {
  serial: string;
  /** Injectable so a host's tests need no live emulator console. */
  readWiring?: typeof readCameraWiring;
  /**
   * Runs after the body is read and before the feed file changes, so a host can
   * refuse a mutation whose device session moved on while the body streamed in.
   */
  beforeMutation?: () => void;
  errorResponse?: (error: unknown) => Response;
};

/**
 * Only the input validators and the body reader know a request is the caller's
 * fault. Everything else that reaches here failed on this host, so it reports
 * 500 rather than sending an agent off to fix a PNG that was already fine.
 * A host that supplies its own `errorResponse` owes the same split.
 */
function defaultCameraErrorResponse(error: unknown): Response {
  if (error instanceof HttpBodyError) {
    return Response.json(
      { ok: false, code: error.code, error: error.message },
      { status: error.status },
    );
  }
  return Response.json(
    { ok: false, error: error instanceof Error ? error.message : String(error) },
    { status: error instanceof CameraInputError ? error.status : 500 },
  );
}

const methodNotAllowed = () => new Response("method not allowed", { status: 405 });

/**
 * A host that must resolve a device serial before it can build the context asks
 * this first, so a non-camera request never pays for that resolve.
 */
export function isCameraPath(pathname: string): boolean {
  return pathname === "/api/camera" || pathname === "/api/camera/image";
}

/**
 * The one camera HTTP handler. Both the standalone server and the middleware
 * router mount it, so the routes cannot drift apart; each supplies only the
 * serial and its own session and error policy.
 */
export async function handleCameraRequest(
  request: Request,
  url: URL,
  context: CameraRequestContext,
): Promise<Response | null> {
  if (!isCameraPath(url.pathname)) return null;
  const isStatusPath = url.pathname === "/api/camera";

  const { serial } = context;
  const readWiring = context.readWiring ?? readCameraWiring;
  const errorResponse = context.errorResponse ?? defaultCameraErrorResponse;
  const statusResponse = async () =>
    Response.json({ ok: true, camera: await readCameraStatus(serial, readWiring) });

  if (isStatusPath) {
    if (request.method !== "GET") return methodNotAllowed();
    try {
      return await statusResponse();
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
    return methodNotAllowed();
  }

  try {
    const facing = parseCameraFacing(url.searchParams.get("facing"));
    if (request.method === "GET") {
      const png = await readCameraImage(serial, facing);
      if (!png) {
        return Response.json(
          {
            ok: false,
            code: "not_found",
            error: `no camera image is set for ${facing}`,
          },
          { status: 404 },
        );
      }
      return cameraImageResponse(png);
    }
    if (request.method === "POST") {
      const png = await readBodyLimited(request, MAX_CAMERA_IMAGE_BYTES);
      context.beforeMutation?.();
      await setCameraImage(serial, facing, png);
    } else {
      context.beforeMutation?.();
      await clearCameraImage(serial, facing);
    }
    return await statusResponse();
  } catch (error) {
    return errorResponse(error);
  }
}
