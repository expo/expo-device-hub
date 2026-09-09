import http2 from "node:http2";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  isEmulatorSerial,
  parseEmulatorSerial,
} from "./device-capabilities.ts";
import { execText, type ExecResult } from "./exec.ts";

/** Minimal dependency-free client for Android Emulator's control gRPC API. */

export type GrpcEndpoint = {
  port: number;
  token: string | null;
  avdName: string | null;
};

const MAX_GRPC_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_PROTO_VARINT_BYTES = 10;
const CONTROLLER_PREFIX = "/android.emulation.control.EmulatorController/";
const UNARY_TIMEOUT_MS = 5_000;
const STREAM_INACTIVITY_TIMEOUT_MS = 10_000;

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(fallback, "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined, fallback: string) {
  if (signal?.aborted) throw abortReason(signal, fallback);
}

function discoveryDirs(): string[] {
  const home = homedir();
  const dirs = [
    join(home, "Library", "Caches", "TemporaryItems", "avd", "running"),
  ];
  if (process.env.XDG_RUNTIME_DIR) {
    dirs.push(join(process.env.XDG_RUNTIME_DIR, "avd", "running"));
  }
  if (process.env.LOCALAPPDATA) {
    dirs.push(join(process.env.LOCALAPPDATA, "Temp", "avd", "running"));
  }
  dirs.push(join(home, ".android", "avd", "running"));
  return dirs;
}

export type EmulatorGrpcDiscoveryDependencies = {
  discoveryDirs?(): string[];
  readDirectory?(directory: string): string[];
  processIsAlive?(file: string): boolean;
  readText?(path: string): string;
  modifiedMs?(path: string): number;
  portIsReachable?(port: number, signal?: AbortSignal): Promise<boolean>;
  pickAvailablePort?(signal?: AbortSignal): Promise<number>;
  runAdb?: typeof execText;
  readAvdName?(serial: string, signal?: AbortSignal): Promise<string | null>;
  wait?(ms: number, signal?: AbortSignal): Promise<void>;
  warn?(message: string): void;
};

function discoveryProcessIsAlive(file: string): boolean {
  const match = file.match(/^pid_(\d+)(?:_info)?\.ini$/);
  if (!match) return false;
  try {
    process.kill(Number(match[1]), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function findEmulatorGrpcEndpoint(
  serial: string,
  dependencies: EmulatorGrpcDiscoveryDependencies = {},
): GrpcEndpoint | null {
  const parsedSerial = parseEmulatorSerial(serial);
  if (!parsedSerial) return null;
  const directories = dependencies.discoveryDirs ?? discoveryDirs;
  const readDirectory = dependencies.readDirectory ?? readdirSync;
  const processIsAlive = dependencies.processIsAlive ?? discoveryProcessIsAlive;
  const readText =
    dependencies.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const readModifiedMs =
    dependencies.modifiedMs ?? ((path: string) => statSync(path).mtimeMs);
  const candidates: Array<GrpcEndpoint & { modifiedMs: number }> = [];
  for (const dir of directories()) {
    let files: string[];
    try {
      files = readDirectory(dir).filter((file) =>
        /^pid_\d+(?:_info)?\.ini$/.test(file),
      );
    } catch {
      continue;
    }
    for (const file of files) {
      if (!processIsAlive(file)) continue;
      const path = join(dir, file);
      let text: string;
      try {
        text = readText(path);
      } catch {
        continue;
      }
      const values = new Map<string, string>();
      for (const line of text.split("\n")) {
        const separator = line.indexOf("=");
        if (separator <= 0) continue;
        values.set(
          line.slice(0, separator).trim(),
          line.slice(separator + 1).trim(),
        );
      }
      if (values.get("port.serial") !== parsedSerial.consolePort) continue;
      const port = Number(values.get("grpc.port"));
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) continue;
      let modifiedMs = 0;
      try {
        modifiedMs = readModifiedMs(path);
      } catch {}
      candidates.push({
        port,
        token: values.get("grpc.token") || null,
        avdName: values.get("avd.name") || null,
        modifiedMs,
      });
    }
  }
  candidates.sort((left, right) => right.modifiedMs - left.modifiedMs);
  const endpoint = candidates[0];
  return endpoint
    ? {
        port: endpoint.port,
        token: endpoint.token,
        avdName: endpoint.avdName,
      }
    : null;
}

async function portIsReachable(
  port: number,
  signal?: AbortSignal,
  timeoutMs = 300,
): Promise<boolean> {
  throwIfAborted(signal, "emulator gRPC discovery aborted");
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (reachable: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(reachable);
    };
    const onAbort = () =>
      finish(false, abortReason(signal!, "emulator gRPC discovery aborted"));
    const timer = setTimeout(() => finish(false), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function pickAvailablePort(signal?: AbortSignal): Promise<number> {
  throwIfAborted(signal, "emulator gRPC discovery aborted");
  return new Promise((resolve, reject) => {
    const server = createServer();
    const onAbort = () => {
      server.close();
      reject(abortReason(signal!, "emulator gRPC discovery aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        signal?.removeEventListener("abort", onAbort);
        reject(new Error("could not allocate a local gRPC port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function commandDetail(result: ExecResult<string>): string {
  return (
    result.stderr.trim() ||
    result.stdout.trim() ||
    result.error?.message ||
    `adb exited with ${result.status ?? "no status"}`
  );
}

async function runningAvdName(
  serial: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await execText("adb", ["-s", serial, "emu", "avd", "name"], {
    timeout: 5_000,
    signal,
    lane: "interactive",
  });
  if (result.status !== 0) return null;
  return (
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && line !== "OK" && !line.startsWith("KO:")) ?? null
  );
}

export function parseEmulatorGrpcPort(output: string): number | null {
  const value = Number(
    output.match(/["']?port["']?\s*:\s*["']?(\d+)/i)?.[1] ??
      output.match(/\bport\s+(\d+)/i)?.[1],
  );
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : null;
}

/** Find or explicitly activate the gRPC endpoint for a running emulator. */
export async function ensureEmulatorGrpcEndpoint(
  serial: string,
  signal?: AbortSignal,
  dependencies: EmulatorGrpcDiscoveryDependencies = {},
): Promise<GrpcEndpoint> {
  if (!isEmulatorSerial(serial)) {
    throw new Error(
      `gRPC screenshot streaming requires an emulator; received ${serial}`,
    );
  }
  const checkPort = dependencies.portIsReachable ?? portIsReachable;
  const allocatePort = dependencies.pickAvailablePort ?? pickAvailablePort;
  const runAdb = dependencies.runAdb ?? execText;
  const readAvdName = dependencies.readAvdName ?? runningAvdName;
  const wait =
    dependencies.wait ??
    ((ms: number, waitSignal?: AbortSignal) =>
      sleep(ms, undefined, { signal: waitSignal }));
  const warn = dependencies.warn ?? console.warn;
  const useEndpoint = (endpoint: GrpcEndpoint): GrpcEndpoint => {
    if (!endpoint.token) {
      warn(
        `serve-emu warning: emulator gRPC endpoint for ${serial} has no bearer token; grpc-screenshot will use this explicitly selected local endpoint without authentication`,
      );
    }
    return endpoint;
  };
  throwIfAborted(signal, "emulator gRPC discovery aborted");
  const discovered = findEmulatorGrpcEndpoint(serial, dependencies);
  if (discovered && (await checkPort(discovered.port, signal))) {
    return useEndpoint(discovered);
  }

  let lastError = discovered
    ? `discovered gRPC port ${discovered.port} is not reachable`
    : "no live emulator gRPC discovery file";
  for (let attempt = 0; attempt < 5; attempt++) {
    throwIfAborted(signal, "emulator gRPC discovery aborted");
    const port = await allocatePort(signal);
    const result = await runAdb(
      "adb",
      ["-s", serial, "emu", "grpc", String(port)],
      { timeout: 5_000, signal, lane: "interactive" },
    );
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.status !== 0 || output.includes("KO:")) {
      lastError = commandDetail(result);
      continue;
    }

    const reportedPort = parseEmulatorGrpcPort(output);
    for (let probe = 0; probe < 40; probe++) {
      throwIfAborted(signal, "emulator gRPC discovery aborted");
      const activated = findEmulatorGrpcEndpoint(serial, dependencies);
      if (activated && (await checkPort(activated.port, signal))) {
        return useEndpoint(activated);
      }
      const activePort = reportedPort ?? port;
      if (probe === 39 && (await checkPort(activePort, signal))) {
        return useEndpoint({
          port: activePort,
          token: null,
          avdName: await readAvdName(serial, signal),
        });
      }
      await wait(50, signal);
    }
    lastError =
      "emulator accepted the gRPC command, but no usable endpoint became reachable";
  }
  throw new Error(
    `could not enable the emulator gRPC endpoint for ${serial}: ${lastError}`,
  );
}

function writeVarint(output: number[], value: number | bigint): void {
  let remaining = BigInt(value);
  if (remaining < 0n) throw new Error("protobuf varints must be non-negative");
  while (remaining > 0x7fn) {
    output.push(Number(remaining & 0x7fn) | 0x80);
    remaining >>= 7n;
  }
  output.push(Number(remaining));
}

function varintField(output: number[], fieldNo: number, value: number): void {
  if (!value) return;
  writeVarint(output, (fieldNo << 3) | 0);
  writeVarint(output, value);
}

function lenField(
  output: number[],
  fieldNo: number,
  bytes: number[] | Buffer,
): void {
  if (!bytes.length) return;
  writeVarint(output, (fieldNo << 3) | 2);
  writeVarint(output, bytes.length);
  for (const byte of bytes) output.push(byte);
}

function messageField(
  output: number[],
  fieldNo: number,
  bytes: number[] | Buffer,
): void {
  writeVarint(output, (fieldNo << 3) | 2);
  writeVarint(output, bytes.length);
  for (const byte of bytes) output.push(byte);
}

function stringField(output: number[], fieldNo: number, value: string): void {
  if (value) lenField(output, fieldNo, Buffer.from(value, "utf8"));
}

type ProtoField =
  | { fieldNo: number; wire: 0; varint: bigint }
  | { fieldNo: number; wire: 1; fixed64: bigint }
  | { fieldNo: number; wire: 2; bytes: Buffer }
  | { fieldNo: number; wire: 5; fixed32: number };

function readVarint(buffer: Buffer, start: number): [bigint, number] {
  let offset = start;
  let shift = 0n;
  let value = 0n;
  for (let count = 0; count < MAX_PROTO_VARINT_BYTES; count++) {
    const byte = buffer[offset++];
    if (byte === undefined) throw new Error("truncated protobuf varint");
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [value, offset];
    shift += 7n;
  }
  throw new Error("protobuf varint exceeds 10 bytes");
}

function* protoFields(buffer: Buffer): Generator<ProtoField> {
  let offset = 0;
  while (offset < buffer.length) {
    let tag: bigint;
    [tag, offset] = readVarint(buffer, offset);
    const fieldNo = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!Number.isSafeInteger(fieldNo) || fieldNo <= 0) {
      throw new Error(`invalid protobuf field number ${fieldNo}`);
    }
    if (wire === 0) {
      let value: bigint;
      [value, offset] = readVarint(buffer, offset);
      yield { fieldNo, wire, varint: value };
    } else if (wire === 2) {
      let rawLength: bigint;
      [rawLength, offset] = readVarint(buffer, offset);
      if (rawLength > BigInt(MAX_GRPC_MESSAGE_BYTES)) {
        throw new Error("protobuf field exceeds message limit");
      }
      const length = Number(rawLength);
      const end = offset + length;
      if (!Number.isSafeInteger(end) || end > buffer.length) {
        throw new Error("truncated protobuf length-delimited field");
      }
      yield { fieldNo, wire, bytes: buffer.subarray(offset, end) };
      offset = end;
    } else if (wire === 5) {
      if (offset + 4 > buffer.length) {
        throw new Error("truncated protobuf fixed32 field");
      }
      yield { fieldNo, wire, fixed32: buffer.readUInt32LE(offset) };
      offset += 4;
    } else if (wire === 1) {
      if (offset + 8 > buffer.length) {
        throw new Error("truncated protobuf fixed64 field");
      }
      yield { fieldNo, wire, fixed64: buffer.readBigUInt64LE(offset) };
      offset += 8;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
}

export const IMG_FORMAT_PNG = 0;
export const IMG_FORMAT_RGBA8888 = 1;
export const IMG_FORMAT_RGB888 = 2;
export const IMAGE_TRANSPORT_UNSPECIFIED = 0;
export const IMAGE_TRANSPORT_MMAP = 1;

export type ImageTransportRequest = {
  channel: typeof IMAGE_TRANSPORT_UNSPECIFIED | typeof IMAGE_TRANSPORT_MMAP;
  handle?: string;
};

export type ImageFormatRequest = {
  format: number;
  width?: number;
  height?: number;
  transport?: ImageTransportRequest;
};

function encodeImageTransport(request: ImageTransportRequest): Buffer {
  if (
    request.channel !== IMAGE_TRANSPORT_UNSPECIFIED &&
    request.channel !== IMAGE_TRANSPORT_MMAP
  ) {
    throw new RangeError(
      `unsupported image transport channel ${request.channel}`,
    );
  }
  if (request.channel === IMAGE_TRANSPORT_MMAP) {
    if (!request.handle?.startsWith("file:///")) {
      throw new Error("MMAP image transport requires a file:/// handle");
    }
  }
  const output: number[] = [];
  varintField(output, 1, request.channel);
  stringField(output, 2, request.handle ?? "");
  return Buffer.from(output);
}

export function encodeImageFormat(request: ImageFormatRequest): Buffer {
  const output: number[] = [];
  varintField(output, 1, request.format);
  varintField(output, 3, request.width ?? 0);
  varintField(output, 4, request.height ?? 0);
  if (request.transport) {
    lenField(output, 6, encodeImageTransport(request.transport));
  }
  return Buffer.from(output);
}

export type EmuImage = {
  width: number;
  height: number;
  format: number;
  rotation: number;
  image: Buffer;
  seq: number;
  timestampUs: bigint;
};

export function decodeEmulatorImage(buffer: Buffer): EmuImage {
  if (buffer.length > MAX_GRPC_MESSAGE_BYTES) {
    throw new Error("emulator image exceeds gRPC message limit");
  }
  const image: EmuImage = {
    width: 0,
    height: 0,
    format: 0,
    rotation: 0,
    image: Buffer.alloc(0),
    seq: 0,
    timestampUs: 0n,
  };
  for (const field of protoFields(buffer)) {
    if (field.fieldNo === 1 && field.wire === 2) {
      for (const sub of protoFields(field.bytes)) {
        if (sub.fieldNo === 1 && sub.wire === 0) {
          image.format = Number(sub.varint);
        } else if (sub.fieldNo === 3 && sub.wire === 0) {
          image.width = Number(sub.varint);
        } else if (sub.fieldNo === 4 && sub.wire === 0) {
          image.height = Number(sub.varint);
        } else if (sub.fieldNo === 2 && sub.wire === 2) {
          for (const rotation of protoFields(sub.bytes)) {
            if (rotation.fieldNo === 1 && rotation.wire === 0) {
              image.rotation = Number(rotation.varint);
            }
          }
        }
      }
    } else if (field.fieldNo === 4 && field.wire === 2) {
      image.image = field.bytes;
    } else if (field.fieldNo === 5 && field.wire === 0) {
      image.seq = Number(field.varint);
    } else if (field.fieldNo === 6 && field.wire === 0) {
      image.timestampUs = field.varint;
    }
  }
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 0 ||
    image.height < 0 ||
    image.width > 16_384 ||
    image.height > 16_384
  ) {
    throw new Error(
      `invalid emulator image size ${image.width}x${image.height}`,
    );
  }
  return image;
}

export type TouchPoint = {
  x: number;
  y: number;
  identifier: number;
  pressure: number;
};

export function encodeTouchEvent(touches: TouchPoint[]): Buffer {
  const output: number[] = [];
  for (const point of touches) {
    const touch: number[] = [];
    varintField(touch, 1, Math.max(0, Math.round(point.x)));
    varintField(touch, 2, Math.max(0, Math.round(point.y)));
    varintField(touch, 3, point.identifier);
    varintField(touch, 4, point.pressure);
    // A repeated message is present even when every scalar has its protobuf
    // default. In particular, pressure=0 releases pointer 0 at pixel 0,0.
    messageField(output, 1, touch);
  }
  return Buffer.from(output);
}

export type KeyboardEventRequest = {
  key?: string;
  text?: string;
  evdev?: number;
  eventType?: "down" | "up" | "press";
};

const KEY_EVENT_TYPE = {
  down: 0,
  up: 1,
  press: 2,
} as const;

export function encodeKeyboardEvent(request: KeyboardEventRequest): Buffer {
  const output: number[] = [];
  if (request.evdev !== undefined) {
    varintField(output, 1, 1);
    varintField(output, 2, KEY_EVENT_TYPE[request.eventType ?? "press"]);
    varintField(output, 3, request.evdev);
    return Buffer.from(output);
  }
  if (request.text === undefined) {
    varintField(output, 2, KEY_EVENT_TYPE[request.eventType ?? "press"]);
  }
  stringField(output, 4, request.key ?? "");
  stringField(output, 5, request.text ?? "");
  return Buffer.from(output);
}

function grpcFrame(message: Buffer): Buffer {
  const output = Buffer.allocUnsafe(5 + message.length);
  output.writeUInt8(0, 0);
  output.writeUInt32BE(message.length, 1);
  message.copy(output, 5);
  return output;
}

class GrpcFrameError extends Error {}

export class GrpcMessageParser {
  readonly #maxMessageBytes: number;
  readonly #onMessage: (message: Buffer) => void;
  readonly #header = Buffer.allocUnsafe(5);
  #headerBytes = 0;
  #message: Buffer | null = null;
  #messageBytes = 0;

  constructor(maxMessageBytes: number, onMessage: (message: Buffer) => void) {
    if (!Number.isInteger(maxMessageBytes) || maxMessageBytes < 0) {
      throw new RangeError("maxMessageBytes must be a non-negative integer");
    }
    this.#maxMessageBytes = Math.min(maxMessageBytes, MAX_GRPC_MESSAGE_BYTES);
    this.#onMessage = onMessage;
  }

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#message === null) {
        const copyBytes = Math.min(
          5 - this.#headerBytes,
          chunk.length - offset,
        );
        chunk.copy(this.#header, this.#headerBytes, offset, offset + copyBytes);
        this.#headerBytes += copyBytes;
        offset += copyBytes;
        if (this.#headerBytes < 5) continue;

        if (this.#header[0] !== 0) {
          throw new GrpcFrameError("compressed gRPC frames are unsupported");
        }
        const length = this.#header.readUInt32BE(1);
        if (length > this.#maxMessageBytes) {
          throw new GrpcFrameError(
            `gRPC message ${length} exceeds ${this.#maxMessageBytes} byte limit`,
          );
        }
        this.#headerBytes = 0;
        this.#message = Buffer.allocUnsafe(length);
        this.#messageBytes = 0;
        if (length === 0) this.#emitMessage();
        continue;
      }

      const copyBytes = Math.min(
        this.#message.length - this.#messageBytes,
        chunk.length - offset,
      );
      chunk.copy(this.#message, this.#messageBytes, offset, offset + copyBytes);
      this.#messageBytes += copyBytes;
      offset += copyBytes;
      if (this.#messageBytes === this.#message.length) this.#emitMessage();
    }
  }

  #emitMessage(): void {
    const message = this.#message!;
    this.#message = null;
    this.#messageBytes = 0;
    this.#onMessage(message);
  }
}

export type GrpcMessagePacingClock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

type PausableGrpcStream = {
  pause(): void;
  resume(): void;
};

export type GrpcMessagePacingEvent = "received" | "emitted" | "coalesced";

export type GrpcMessagePacingDetail = {
  /** Protobuf body size, excluding the five-byte gRPC frame prefix. */
  messageBytes: number;
  /** Time retained by the client pacer before emission or replacement. */
  pacingDelayMs: number;
};

export type GrpcImageDecodeEvent = {
  messageBytes: number;
  decodeMs: number;
};

const SYSTEM_PACING_CLOCK: GrpcMessagePacingClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Applies transport backpressure between streamed gRPC messages. The parser
 * consumes the current chunk but retains only its newest pending raw message,
 * so a burst cannot trigger multiple expensive decodes in one frame slot.
 */
export class GrpcMessagePacer {
  readonly #stream: PausableGrpcStream;
  readonly #parser: GrpcMessageParser;
  readonly #messageIntervalMs: number;
  readonly #onMessage: (message: Buffer, receivedAtMs: number) => void;
  readonly #onPacingEvent:
    | ((event: GrpcMessagePacingEvent, detail: GrpcMessagePacingDetail) => void)
    | undefined;
  readonly #onError: (error: Error) => void;
  readonly #clock: GrpcMessagePacingClock;
  readonly #signal: AbortSignal | undefined;
  readonly #onAbort = () => this.close();
  #pendingMessage: {
    message: Buffer;
    receivedAtMs: number;
    receivedAtMonotonicMs: number;
  } | null = null;
  #timer: unknown = null;
  #nextMessageAt: number | null = null;
  #paused = false;
  #closed = false;

  constructor(options: {
    stream: PausableGrpcStream;
    maxMessageBytes: number;
    messageIntervalMs: number;
    onMessage: (message: Buffer, receivedAtMs: number) => void;
    onPacingEvent?: (
      event: GrpcMessagePacingEvent,
      detail: GrpcMessagePacingDetail,
    ) => void;
    onError: (error: Error) => void;
    signal?: AbortSignal;
    clock?: GrpcMessagePacingClock;
  }) {
    if (
      !Number.isFinite(options.messageIntervalMs) ||
      options.messageIntervalMs <= 0
    ) {
      throw new RangeError("messageIntervalMs must be a positive number");
    }
    this.#stream = options.stream;
    this.#parser = new GrpcMessageParser(options.maxMessageBytes, (message) =>
      this.#handleMessage(message),
    );
    this.#messageIntervalMs = options.messageIntervalMs;
    this.#onMessage = options.onMessage;
    this.#onPacingEvent = options.onPacingEvent;
    this.#onError = options.onError;
    this.#clock = options.clock ?? SYSTEM_PACING_CLOCK;
    this.#signal = options.signal;
    if (options.signal?.aborted) this.#closed = true;
    else
      options.signal?.addEventListener("abort", this.#onAbort, { once: true });
  }

  push(chunk: Buffer): void {
    if (this.#closed || chunk.length === 0) return;
    try {
      this.#parser.push(chunk);
    } catch (error) {
      this.#fail(error);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#pendingMessage = null;
    this.#signal?.removeEventListener("abort", this.#onAbort);
  }

  #handleMessage(message: Buffer): void {
    if (this.#closed) return;
    const received = {
      message,
      receivedAtMs: Date.now(),
      receivedAtMonotonicMs: this.#clock.now(),
    };
    this.#onPacingEvent?.("received", {
      messageBytes: message.length,
      pacingDelayMs: 0,
    });
    if (this.#paused) {
      // A data chunk may already contain several frames when pause() takes
      // effect. Keep only the newest raw protobuf and decode it next slot.
      if (this.#pendingMessage) {
        this.#onPacingEvent?.("coalesced", {
          messageBytes: this.#pendingMessage.message.length,
          pacingDelayMs: Math.max(
            0,
            this.#clock.now() - this.#pendingMessage.receivedAtMonotonicMs,
          ),
        });
      }
      this.#pendingMessage = received;
      return;
    }
    this.#emitMessage(received);
  }

  #emitMessage(received: {
    message: Buffer;
    receivedAtMs: number;
    receivedAtMonotonicMs: number;
  }): void {
    if (!this.#paused) {
      this.#paused = true;
      this.#stream.pause();
    }
    const now = this.#clock.now();
    this.#nextMessageAt = Math.max(
      (this.#nextMessageAt ?? now) + this.#messageIntervalMs,
      now + this.#messageIntervalMs,
    );
    this.#onPacingEvent?.("emitted", {
      messageBytes: received.message.length,
      pacingDelayMs: Math.max(0, now - received.receivedAtMonotonicMs),
    });
    this.#onMessage(received.message, received.receivedAtMs);
    this.#scheduleNextSlot();
  }

  #scheduleNextSlot(): void {
    this.#timer = this.#clock.setTimeout(
      () => this.#onNextSlot(),
      Math.max(0, this.#nextMessageAt! - this.#clock.now()),
    );
    if (
      typeof this.#timer === "object" &&
      this.#timer !== null &&
      "unref" in this.#timer
    ) {
      (this.#timer as { unref(): void }).unref();
    }
  }

  #onNextSlot(): void {
    this.#timer = null;
    if (this.#closed) return;
    try {
      if (this.#pendingMessage) {
        const message = this.#pendingMessage;
        this.#pendingMessage = null;
        this.#emitMessage(message);
        return;
      }
      this.#paused = false;
      this.#stream.resume();
    } catch (error) {
      this.#fail(error);
    }
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    const cause = error instanceof Error ? error : new Error(String(error));
    this.close();
    this.#onError(cause);
  }
}

type RequestOptions = {
  onMessage?: (message: Buffer, receivedAtMs: number) => void;
  onPacingEvent?: (
    event: GrpcMessagePacingEvent,
    detail: GrpcMessagePacingDetail,
  ) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxMessageBytes?: number;
  messageIntervalMs?: number;
  inactivityTimeoutMs?: number;
  onInactivity?: () => Promise<void>;
};

export type EmulatorGrpcClientOptions = {
  unaryTimeoutMs?: number;
  streamInactivityTimeoutMs?: number;
};

export type GrpcScreenshotImageSource = "stream" | "probe";

function positiveTimeout(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return value;
}

export class EmulatorGrpcClient {
  readonly #session: http2.ClientHttp2Session;
  readonly #endpoint: GrpcEndpoint;
  readonly #unaryTimeoutMs: number;
  readonly #streamInactivityTimeoutMs: number;
  readonly #errorListeners = new Set<(error: Error) => void>();
  #closed = false;

  constructor(endpoint: GrpcEndpoint, options: EmulatorGrpcClientOptions = {}) {
    this.#endpoint = endpoint;
    this.#unaryTimeoutMs = positiveTimeout(
      options.unaryTimeoutMs ?? UNARY_TIMEOUT_MS,
      "unaryTimeoutMs",
    );
    this.#streamInactivityTimeoutMs = positiveTimeout(
      options.streamInactivityTimeoutMs ?? STREAM_INACTIVITY_TIMEOUT_MS,
      "streamInactivityTimeoutMs",
    );
    this.#session = http2.connect(`http://127.0.0.1:${endpoint.port}`);
    this.#session.on("error", (error: Error) => {
      if (!this.#closed) {
        for (const listener of this.#errorListeners) listener(error);
      }
    });
  }

  onSessionError(listener: (error: Error) => void): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  #request(
    method: string,
    message: Buffer,
    options: RequestOptions = {},
  ): Promise<Buffer[]> {
    return new Promise((resolve, reject) => {
      if (this.#closed) {
        reject(new Error("emulator gRPC client is closed"));
        return;
      }
      if (options.signal?.aborted) {
        reject(abortReason(options.signal, `${method} aborted`));
        return;
      }
      const headers: http2.OutgoingHttpHeaders = {
        ":method": "POST",
        ":path": CONTROLLER_PREFIX + method,
        "content-type": "application/grpc",
        te: "trailers",
      };
      if (this.#endpoint.token) {
        headers.authorization = `Bearer ${this.#endpoint.token}`;
      }
      const stream = this.#session.request(headers);
      const messages: Buffer[] = [];
      const maxMessageBytes = Math.min(
        options.maxMessageBytes ?? MAX_GRPC_MESSAGE_BYTES,
        MAX_GRPC_MESSAGE_BYTES,
      );
      let grpcStatus: string | null = null;
      let grpcMessage = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
      let activityGeneration = 0;
      let pacer: GrpcMessagePacer | null = null;

      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (inactivityTimer) clearTimeout(inactivityTimer);
        pacer?.close();
        options.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(messages);
      };
      const resetInactivityTimer = () => {
        if (!options.inactivityTimeoutMs || settled) return;
        if (inactivityTimer) clearTimeout(inactivityTimer);
        const generation = ++activityGeneration;
        inactivityTimer = setTimeout(() => {
          inactivityTimer = null;
          void (async () => {
            try {
              if (!options.onInactivity) {
                throw new Error("no health probe is configured");
              }
              await options.onInactivity();
              if (!settled && generation === activityGeneration) {
                resetInactivityTimer();
              }
            } catch (error) {
              if (settled || generation !== activityGeneration) return;
              const detail =
                error instanceof Error ? error.message : String(error);
              settle(
                new Error(
                  `${method}: no decoded message received for ${options.inactivityTimeoutMs}ms; health probe failed: ${detail}`,
                ),
              );
              stream.close(http2.constants.NGHTTP2_CANCEL);
            }
          })();
        }, options.inactivityTimeoutMs);
        inactivityTimer.unref?.();
      };
      const onMessage = (body: Buffer, receivedAtMs = Date.now()) => {
        if (options.onMessage) options.onMessage(body, receivedAtMs);
        else messages.push(body);
        resetInactivityTimer();
      };
      const parser = options.messageIntervalMs
        ? null
        : new GrpcMessageParser(maxMessageBytes, (body) => {
            const receivedAtMs = Date.now();
            const detail = { messageBytes: body.length, pacingDelayMs: 0 };
            options.onPacingEvent?.("received", detail);
            options.onPacingEvent?.("emitted", detail);
            onMessage(body, receivedAtMs);
          });
      const onAbort = () => {
        try {
          stream.close(http2.constants.NGHTTP2_CANCEL);
        } catch {}
        settle(abortReason(options.signal!, `${method} aborted`));
      };
      const takeStatus = (values: Record<string, unknown>) => {
        if (values["grpc-status"] === undefined) return;
        grpcStatus = String(values["grpc-status"]);
        try {
          grpcMessage = decodeURIComponent(
            String(values["grpc-message"] ?? ""),
          );
        } catch {
          grpcMessage = String(values["grpc-message"] ?? "");
        }
      };
      const cancelForFrameError = (error: unknown) => {
        const cause = error instanceof Error ? error : new Error(String(error));
        settle(
          cause instanceof GrpcFrameError
            ? new Error(`${method}: ${cause.message}`)
            : cause,
        );
        stream.close(http2.constants.NGHTTP2_CANCEL);
      };
      if (options.messageIntervalMs) {
        pacer = new GrpcMessagePacer({
          stream,
          maxMessageBytes,
          messageIntervalMs: options.messageIntervalMs,
          onMessage,
          onPacingEvent: options.onPacingEvent,
          onError: cancelForFrameError,
          signal: options.signal,
        });
      }

      stream.on("response", (values) =>
        takeStatus(values as Record<string, unknown>),
      );
      stream.on("trailers", (values) =>
        takeStatus(values as Record<string, unknown>),
      );
      stream.on("data", (chunk: Buffer) => {
        if (settled) return;
        try {
          if (pacer) pacer.push(chunk);
          else parser!.push(chunk);
        } catch (error) {
          cancelForFrameError(error);
        }
      });
      stream.on("error", (error: Error) => {
        if (!settled) settle(new Error(`${method}: ${error.message}`));
      });
      stream.on("close", () => {
        if (settled) return;
        if (grpcStatus === "0") settle();
        else if (grpcStatus !== null) {
          settle(
            new Error(
              `${method}: grpc-status ${grpcStatus}${grpcMessage ? ` (${grpcMessage})` : ""}`,
            ),
          );
        } else {
          settle(new Error(`${method}: stream closed without grpc status`));
        }
      });
      if (options.timeoutMs) {
        timer = setTimeout(() => {
          settle(
            new Error(`${method}: timed out after ${options.timeoutMs}ms`),
          );
          stream.close(http2.constants.NGHTTP2_CANCEL);
        }, options.timeoutMs);
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      stream.end(grpcFrame(message));
    });
  }

  async getScreenshot(
    format: ImageFormatRequest,
    signal?: AbortSignal,
  ): Promise<EmuImage> {
    const [message] = await this.#request(
      "getScreenshot",
      encodeImageFormat(format),
      { timeoutMs: this.#unaryTimeoutMs, signal },
    );
    if (!message) throw new Error("getScreenshot returned no image");
    return decodeEmulatorImage(message);
  }

  async streamScreenshot(
    format: ImageFormatRequest,
    onImage: (
      image: EmuImage,
      source: GrpcScreenshotImageSource,
      receivedAtMs: number,
    ) => void,
    signal: AbortSignal,
    options: {
      maxFps?: number;
      onPacingEvent?: (
        event: GrpcMessagePacingEvent,
        detail: GrpcMessagePacingDetail,
      ) => void;
      onDecode?: (event: GrpcImageDecodeEvent) => void;
    } = {},
  ): Promise<void> {
    let streamedImageGeneration = 0;
    const messageIntervalMs =
      options.maxFps === undefined ? undefined : 1_000 / options.maxFps;
    if (
      messageIntervalMs !== undefined &&
      (!Number.isFinite(messageIntervalMs) || messageIntervalMs <= 0)
    ) {
      throw new RangeError("maxFps must be a positive number");
    }
    try {
      await this.#request("streamScreenshot", encodeImageFormat(format), {
        signal,
        messageIntervalMs,
        inactivityTimeoutMs: this.#streamInactivityTimeoutMs,
        onInactivity: async () => {
          // Static emulator displays may legitimately stop producing stream
          // notifications. A bounded unary capture distinguishes that from a
          // dead endpoint and also refreshes the frame while the stream is idle.
          const generation = streamedImageGeneration;
          const image = await this.getScreenshot(format, signal);
          if (generation === streamedImageGeneration && !signal.aborted) {
            onImage(image, "probe", Date.now());
          }
        },
        onPacingEvent: options.onPacingEvent,
        onMessage: (message, receivedAtMs) => {
          streamedImageGeneration++;
          const startedAt = performance.now();
          const image = decodeEmulatorImage(message);
          options.onDecode?.({
            messageBytes: message.length,
            decodeMs: Math.max(0, performance.now() - startedAt),
          });
          onImage(image, "stream", receivedAtMs);
        },
      });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }

  async sendTouch(touches: TouchPoint[], signal?: AbortSignal): Promise<void> {
    await this.#request("sendTouch", encodeTouchEvent(touches), {
      timeoutMs: this.#unaryTimeoutMs,
      signal,
      maxMessageBytes: 1024,
    });
  }

  async sendKey(
    event: KeyboardEventRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#request("sendKey", encodeKeyboardEvent(event), {
      timeoutMs: this.#unaryTimeoutMs,
      signal,
      maxMessageBytes: 1024,
    });
  }

  async sendEvdevKeyPress(
    keyCode: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isInteger(keyCode) || keyCode <= 0) {
      throw new Error(`invalid evdev keycode ${keyCode}`);
    }
    await this.sendKey({ evdev: keyCode }, signal);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#session.destroy();
    } catch {}
    this.#errorListeners.clear();
  }
}
