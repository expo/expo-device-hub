import http2 from "node:http2";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Minimal client for the Android Emulator's built-in gRPC control endpoint
 * (android.emulation.control.EmulatorController). The emulator process serves
 * the guest framebuffer and injects input host-side, so unlike scrcpy none of
 * it costs the guest any CPU.
 *
 * gRPC is protobuf messages over HTTP/2 with a 5-byte length prefix, and we
 * only need four RPCs with a handful of scalar fields, so the wire format is
 * hand-rolled on top of node:http2 to keep the package dependency-free. The
 * schema ships with the SDK: $ANDROID_HOME/emulator/lib/emulator_controller.proto.
 */

export type GrpcEndpoint = {
  port: number;
  token: string | null;
  avdName: string | null;
};

// ---------------------------------------------------------------------------
// Endpoint discovery
// ---------------------------------------------------------------------------

function discoveryDirs(): string[] {
  const home = homedir();
  const dirs = [join(home, "Library", "Caches", "TemporaryItems", "avd", "running")];
  if (process.env.XDG_RUNTIME_DIR) dirs.push(join(process.env.XDG_RUNTIME_DIR, "avd", "running"));
  if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, "Temp", "avd", "running"));
  dirs.push(join(home, ".android", "avd", "running"));
  return dirs;
}

/**
 * Find the gRPC control endpoint of a running emulator by its adb serial.
 * Every modern emulator writes a discovery file (`pid_<pid>.ini`, same files
 * Android Studio uses) containing its gRPC port and, when auth is on (the
 * default), a bearer token. Returns null when no discovery file matches —
 * e.g. a physical device, or an emulator running with gRPC disabled.
 */
export function findEmulatorGrpcEndpoint(serial: string): GrpcEndpoint | null {
  const match = serial.match(/^emulator-(\d+)$/);
  if (!match) return null;
  for (const dir of discoveryDirs()) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => /^pid_\d+\.ini$/.test(f));
    } catch {
      continue;
    }
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(join(dir, file), "utf8");
      } catch {
        continue;
      }
      const kv = new Map<string, string>();
      for (const line of text.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
      }
      if (kv.get("port.serial") !== match[1]) continue;
      const port = Number(kv.get("grpc.port"));
      if (!Number.isInteger(port) || port <= 0) continue;
      return { port, token: kv.get("grpc.token") || null, avdName: kv.get("avd.name") || null };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Protobuf wire format (only what the four RPCs need)
// ---------------------------------------------------------------------------

function writeVarint(out: number[], value: number | bigint): void {
  let v = BigInt(value);
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
}

// proto3 scalar defaults are omitted on the wire.
function varintField(out: number[], fieldNo: number, value: number): void {
  if (!value) return;
  writeVarint(out, (fieldNo << 3) | 0);
  writeVarint(out, value);
}

function lenField(out: number[], fieldNo: number, bytes: number[] | Buffer): void {
  if (!bytes.length) return;
  writeVarint(out, (fieldNo << 3) | 2);
  writeVarint(out, bytes.length);
  for (const b of bytes) out.push(b);
}

function stringField(out: number[], fieldNo: number, value: string): void {
  if (!value) return;
  lenField(out, fieldNo, Buffer.from(value, "utf8"));
}

type ProtoField =
  | { fieldNo: number; wire: 0; varint: bigint }
  | { fieldNo: number; wire: 1; fixed64: bigint }
  | { fieldNo: number; wire: 2; bytes: Buffer }
  | { fieldNo: number; wire: 5; fixed32: number };

function readVarint(buf: Buffer, offset: number): [bigint, number] {
  let shift = 0n;
  let value = 0n;
  for (;;) {
    const byte = buf[offset++];
    if (byte === undefined) throw new Error("truncated varint");
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [value, offset];
    shift += 7n;
  }
}

function* protoFields(buf: Buffer): Generator<ProtoField> {
  let offset = 0;
  while (offset < buf.length) {
    let tag: bigint;
    [tag, offset] = readVarint(buf, offset);
    const fieldNo = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      let value: bigint;
      [value, offset] = readVarint(buf, offset);
      yield { fieldNo, wire, varint: value };
    } else if (wire === 2) {
      let len: bigint;
      [len, offset] = readVarint(buf, offset);
      const end = offset + Number(len);
      yield { fieldNo, wire, bytes: buf.subarray(offset, end) };
      offset = end;
    } else if (wire === 5) {
      yield { fieldNo, wire, fixed32: buf.readUInt32LE(offset) };
      offset += 4;
    } else if (wire === 1) {
      yield { fieldNo, wire, fixed64: buf.readBigUInt64LE(offset) };
      offset += 8;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
}

// ImageFormat.ImgFormat
export const IMG_FORMAT_PNG = 0;
export const IMG_FORMAT_RGBA8888 = 1;
export const IMG_FORMAT_RGB888 = 2;

export type ImageFormatRequest = {
  format: number;
  /** Fit box: the emulator scales the frame to fit width×height, preserving aspect. 0 = native. */
  width?: number;
  height?: number;
};

// ImageFormat { ImgFormat format=1; Rotation rotation=2; uint32 width=3; uint32 height=4; uint32 display=5 }
function encodeImageFormat(req: ImageFormatRequest): Buffer {
  const out: number[] = [];
  varintField(out, 1, req.format);
  varintField(out, 3, req.width ?? 0);
  varintField(out, 4, req.height ?? 0);
  return Buffer.from(out);
}

export type EmuImage = {
  width: number;
  height: number;
  format: number;
  /** Rotation.SkinRotation: 0 portrait, 1 landscape, 2 reverse portrait, 3 reverse landscape. */
  rotation: number;
  /** Raw payload: PNG file or top-down packed pixels, per the requested format. */
  image: Buffer;
  seq: number;
  timestampUs: bigint;
};

// Image { ImageFormat format=1; bytes image=4; uint32 seq=5; uint64 timestampUs=6 }
function decodeImage(buf: Buffer): EmuImage {
  const image: EmuImage = {
    width: 0,
    height: 0,
    format: 0,
    rotation: 0,
    image: Buffer.alloc(0),
    seq: 0,
    timestampUs: 0n,
  };
  for (const field of protoFields(buf)) {
    if (field.fieldNo === 1 && field.wire === 2) {
      for (const sub of protoFields(field.bytes)) {
        if (sub.fieldNo === 1 && sub.wire === 0) image.format = Number(sub.varint);
        else if (sub.fieldNo === 3 && sub.wire === 0) image.width = Number(sub.varint);
        else if (sub.fieldNo === 4 && sub.wire === 0) image.height = Number(sub.varint);
        else if (sub.fieldNo === 2 && sub.wire === 2) {
          for (const rot of protoFields(sub.bytes)) {
            if (rot.fieldNo === 1 && rot.wire === 0) image.rotation = Number(rot.varint);
          }
        }
      }
    } else if (field.fieldNo === 4 && field.wire === 2) image.image = field.bytes;
    else if (field.fieldNo === 5 && field.wire === 0) image.seq = Number(field.varint);
    else if (field.fieldNo === 6 && field.wire === 0) image.timestampUs = field.varint;
  }
  return image;
}

export type TouchPoint = {
  /** Native display pixels (not stream pixels), origin top-left. */
  x: number;
  y: number;
  /** Tracks one finger across down/move/up; reused after release. */
  identifier: number;
  /** Nonzero while touching; 0 releases the identifier. */
  pressure: number;
};

// TouchEvent { repeated Touch touches=1; int32 display=2 }
// Touch { int32 x=1; int32 y=2; int32 identifier=3; int32 pressure=4 }
function encodeTouchEvent(touches: TouchPoint[]): Buffer {
  const out: number[] = [];
  for (const t of touches) {
    const touch: number[] = [];
    varintField(touch, 1, Math.max(0, Math.round(t.x)));
    varintField(touch, 2, Math.max(0, Math.round(t.y)));
    varintField(touch, 3, t.identifier);
    varintField(touch, 4, t.pressure);
    lenField(out, 1, touch);
  }
  return Buffer.from(out);
}

export type KeyboardEventRequest = {
  /**
   * W3C KeyboardEvent.key value, sent as a keypress (down+up). The emulator
   * understands the Android-specific values "GoBack", "GoHome", "AppSwitch"
   * and "Power" in addition to regular keys ("Enter", "a", ...).
   */
  key?: string;
  /** UTF-8 text typed as a sequence of keypresses; overrides `key`. */
  text?: string;
};

// KeyboardEvent { KeyCodeType codeType=1; KeyEventType eventType=2; int32 keyCode=3; string key=4; string text=5 }
const KEY_EVENT_TYPE_KEYPRESS = 2;

function encodeKeyboardEvent(req: KeyboardEventRequest): Buffer {
  const out: number[] = [];
  if (!req.text) varintField(out, 2, KEY_EVENT_TYPE_KEYPRESS);
  stringField(out, 4, req.key ?? "");
  stringField(out, 5, req.text ?? "");
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// gRPC over HTTP/2
// ---------------------------------------------------------------------------

const CONTROLLER_PREFIX = "/android.emulation.control.EmulatorController/";
const UNARY_TIMEOUT_MS = 5_000;

function grpcFrame(message: Buffer): Buffer {
  const out = Buffer.allocUnsafe(5 + message.length);
  out.writeUInt8(0, 0); // uncompressed
  out.writeUInt32BE(message.length, 1);
  message.copy(out, 5);
  return out;
}

type RequestOpts = {
  onMessage?: (message: Buffer) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export class EmulatorGrpcClient {
  private http2Session: http2.ClientHttp2Session;
  private closed = false;
  private sessionErrorCb: ((err: Error) => void) | null = null;

  constructor(private endpoint: GrpcEndpoint) {
    this.http2Session = http2.connect(`http://127.0.0.1:${endpoint.port}`);
    this.http2Session.on("error", (err: Error) => {
      if (!this.closed) this.sessionErrorCb?.(err);
    });
  }

  /** Connection-level errors (individual calls also reject on their own). */
  onSessionError(cb: (err: Error) => void): void {
    this.sessionErrorCb = cb;
  }

  private request(method: string, message: Buffer, opts: RequestOpts = {}): Promise<Buffer[]> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("emulator grpc client is closed"));
      const headers: http2.OutgoingHttpHeaders = {
        ":method": "POST",
        ":path": CONTROLLER_PREFIX + method,
        "content-type": "application/grpc",
        te: "trailers",
      };
      if (this.endpoint.token) headers.authorization = `Bearer ${this.endpoint.token}`;

      const stream = this.http2Session.request(headers);
      const messages: Buffer[] = [];
      const chunks: Buffer[] = [];
      let buffered = 0;
      let frameEnd = -1;
      let grpcStatus: string | null = null;
      let grpcMessage = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve(messages);
      };
      const onAbort = () => {
        try {
          stream.close(http2.constants.NGHTTP2_CANCEL);
        } catch {}
        settle();
      };

      const takeStatus = (h: Record<string, unknown>) => {
        if (h["grpc-status"] === undefined) return;
        grpcStatus = String(h["grpc-status"]);
        try {
          grpcMessage = decodeURIComponent(String(h["grpc-message"] ?? ""));
        } catch {
          grpcMessage = String(h["grpc-message"] ?? "");
        }
      };

      stream.on("response", (h) => takeStatus(h as Record<string, unknown>));
      stream.on("trailers", (t) => takeStatus(t as Record<string, unknown>));
      stream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        buffered += chunk.length;
        for (;;) {
          if (frameEnd < 0) {
            if (buffered < 5) break;
            const head = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
            chunks.length = 0;
            chunks.push(head);
            if (head[0] !== 0) {
              settle(new Error(`${method}: compressed grpc frames are not supported`));
              try {
                stream.close(http2.constants.NGHTTP2_CANCEL);
              } catch {}
              return;
            }
            frameEnd = 5 + head.readUInt32BE(1);
          }
          if (buffered < frameEnd) break;
          const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
          const body = all.subarray(5, frameEnd);
          const rest = all.subarray(frameEnd);
          chunks.length = 0;
          buffered = rest.length;
          if (rest.length) chunks.push(rest);
          frameEnd = -1;
          if (opts.onMessage) opts.onMessage(body);
          else messages.push(body);
        }
      });
      stream.on("error", (err: Error) => {
        if (opts.signal?.aborted) settle();
        else settle(new Error(`${method}: ${err.message}`));
      });
      stream.on("close", () => {
        if (opts.signal?.aborted || grpcStatus === "0") settle();
        else if (grpcStatus !== null) settle(new Error(`${method}: grpc-status ${grpcStatus}${grpcMessage ? ` (${grpcMessage})` : ""}`));
        else settle(new Error(`${method}: stream closed without grpc status`));
      });

      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          settle(new Error(`${method}: timed out after ${opts.timeoutMs}ms`));
          try {
            stream.close(http2.constants.NGHTTP2_CANCEL);
          } catch {}
        }, opts.timeoutMs);
      }
      if (opts.signal) {
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener("abort", onAbort);
      }

      stream.end(grpcFrame(message));
    });
  }

  /** One frame of the main display; with width/height 0 the native size is returned. */
  async getScreenshot(format: ImageFormatRequest): Promise<EmuImage> {
    const [message] = await this.request("getScreenshot", encodeImageFormat(format), {
      timeoutMs: UNARY_TIMEOUT_MS,
    });
    if (!message) throw new Error("getScreenshot returned no image");
    return decodeImage(message);
  }

  /**
   * Push-stream of frames, delivered only when the display changes (the
   * current frame is sent immediately on connect). Resolves when aborted.
   */
  streamScreenshot(
    format: ImageFormatRequest,
    onImage: (image: EmuImage) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return this.request("streamScreenshot", encodeImageFormat(format), {
      signal,
      onMessage: (message) => onImage(decodeImage(message)),
    }).then(() => undefined);
  }

  async sendTouch(touches: TouchPoint[]): Promise<void> {
    await this.request("sendTouch", encodeTouchEvent(touches), { timeoutMs: UNARY_TIMEOUT_MS });
  }

  async sendKey(event: KeyboardEventRequest): Promise<void> {
    await this.request("sendKey", encodeKeyboardEvent(event), { timeoutMs: UNARY_TIMEOUT_MS });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.http2Session.destroy();
    } catch {}
  }
}
