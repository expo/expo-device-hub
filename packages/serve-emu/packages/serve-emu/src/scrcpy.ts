import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { SCRCPY_VERSION, ensureScrcpyServer } from "../scripts/fetch-scrcpy.ts";

const DEVICE_JAR_PATH = "/data/local/tmp/scrcpy-server.jar";

export type ScrcpyMeta = {
  deviceName: string;
  codecId: string;
  width: number;
  height: number;
};

export type ScrcpySession = {
  transport: "scrcpy";
  meta: ScrcpyMeta;
  videoReader: FramedReader;
  controlSocket: Socket;
  proc: ChildProcess;
  scid: string;
  localPort: number;
  serial: string;
  readFrame: () => Promise<VideoFrame | null>;
  close: () => void;
};

export type StartOpts = {
  serial: string;
  maxFps?: number;
  bitRate?: number;
  maxSize?: number;
  keyFrameInterval?: number;
};

export type VideoFrame = {
  data: Buffer;
  pts: bigint;
  isConfig: boolean;
  isKey: boolean;
};

function adb(serial: string, args: string[]) {
  const r = spawnSync("adb", ["-s", serial, ...args], { encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(`adb -s ${serial} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function pickPort(): number {
  return 27200 + Math.floor(Math.random() * 2000);
}

function removeForward(serial: string, port: number): void {
  const r = spawnSync("adb", ["-s", serial, "forward", "--remove", `tcp:${port}`], {
    encoding: "utf8",
  });
  if (r.status !== 0 && !r.stderr.includes("cannot remove listener")) {
    throw new Error(`adb -s ${serial} forward --remove tcp:${port} failed: ${r.stderr}`);
  }
}

function forwardedPort(serial: string, target: string): number | null {
  const r = spawnSync("adb", ["-s", serial, "forward", "--list"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  for (const line of r.stdout.split("\n")) {
    const match = line.match(/^(\S+)\s+tcp:(\d+)\s+(.+)$/);
    if (!match) continue;
    if (match[1] === serial && match[3] === target) return Number(match[2]);
  }
  return null;
}

function forwardAbstractSocket(serial: string, scid: string): number {
  const target = `localabstract:scrcpy_${scid}`;
  const dynamic = spawnSync("adb", ["-s", serial, "forward", "tcp:0", target], {
    encoding: "utf8",
  });
  if (dynamic.status === 0) {
    const port = Number(dynamic.stdout.trim()) || forwardedPort(serial, target);
    if (port && Number.isInteger(port)) return port;
  }

  let lastError = dynamic.stderr.trim() || "adb did not return a forwarded port";
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = pickPort();
    const fixed = spawnSync("adb", ["-s", serial, "forward", `tcp:${port}`, target], {
      encoding: "utf8",
    });
    if (fixed.status === 0) return port;
    lastError = fixed.stderr.trim() || lastError;
  }
  throw new Error(`Failed to create adb forward for ${target}: ${lastError}`);
}

function randomScid(): string {
  // scrcpy parses scid with Integer.parseInt(radix=16), which is a *signed*
  // 32-bit value, so the high bit must stay clear (max 0x7FFFFFFF).
  return Math.floor(Math.random() * 0x7fffffff)
    .toString(16)
    .padStart(8, "0");
}

const MAX_READER_BUFFER_BYTES = 32 * 1024 * 1024;

class FramedReader {
  private chunks: Buffer[] = [];
  private firstChunkOffset = 0;
  private total = 0;
  private waiters: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
  private err: Error | null = null;

  constructor(public readonly sock: Socket) {
    sock.on("data", (d: Buffer) => {
      if (this.total + d.length > MAX_READER_BUFFER_BYTES) {
        this.err = new Error("scrcpy video reader buffer overflow");
        while (this.waiters.length) this.waiters.shift()!.reject(this.err);
        this.chunks.length = 0;
        this.total = 0;
        return;
      }
      this.chunks.push(d);
      this.total += d.length;
      this.flush();
    });
    const fail = (e: Error) => {
      this.err = e;
      while (this.waiters.length) this.waiters.shift()!.reject(e);
    };
    sock.on("error", fail);
    sock.on("end", () => fail(new Error("scrcpy video socket ended")));
    sock.on("close", () => fail(new Error("scrcpy video socket closed")));
  }

  read(n: number): Promise<Buffer> {
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => {
      this.waiters.push({ n, resolve, reject });
      this.flush();
    });
  }

  prepend(data: Buffer): void {
    if (data.length === 0) return;
    if (this.firstChunkOffset > 0 && this.chunks.length > 0) {
      this.chunks[0] = this.chunks[0].subarray(this.firstChunkOffset);
      this.firstChunkOffset = 0;
    }
    this.chunks.unshift(data);
    this.total += data.length;
    this.flush();
  }

  private consume(n: number): Buffer {
    const first = this.chunks[0];
    const firstAvailable = first.length - this.firstChunkOffset;
    if (firstAvailable >= n) {
      const out = first.subarray(this.firstChunkOffset, this.firstChunkOffset + n);
      this.firstChunkOffset += n;
      this.total -= n;
      if (this.firstChunkOffset === first.length) {
        this.chunks.shift();
        this.firstChunkOffset = 0;
      }
      return out;
    }

    const out = Buffer.allocUnsafe(n);
    let written = 0;
    while (written < n) {
      const chunk = this.chunks[0];
      const available = chunk.length - this.firstChunkOffset;
      const take = Math.min(n - written, available);
      chunk.copy(out, written, this.firstChunkOffset, this.firstChunkOffset + take);
      written += take;
      this.firstChunkOffset += take;
      this.total -= take;
      if (this.firstChunkOffset === chunk.length) {
        this.chunks.shift();
        this.firstChunkOffset = 0;
      }
    }
    return out;
  }

  private flush() {
    while (this.waiters.length && this.total >= this.waiters[0].n) {
      const w = this.waiters.shift()!;
      w.resolve(this.consume(w.n));
    }
  }
}

async function waitForAbstractSocket(serial: string, name: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = spawnSync("adb", ["-s", serial, "shell", "cat", "/proc/net/unix"], {
      encoding: "utf8",
    });
    if (r.stdout && r.stdout.includes(`@${name}`)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for scrcpy abstract socket @${name}`);
}

async function connectOnce(port: number, timeoutMs = 3_000): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host: "127.0.0.1", port });
    const timeout = setTimeout(() => {
      s.destroy();
      reject(new Error(`Timed out connecting to adb forward tcp:${port}`));
    }, timeoutMs);
    const onError = (e: Error) => {
      clearTimeout(timeout);
      s.removeListener("connect", onConnect);
      reject(e);
    };
    const onConnect = () => {
      clearTimeout(timeout);
      s.removeListener("error", onError);
      resolve(s);
    };
    s.once("error", onError);
    s.once("connect", onConnect);
  });
}

const CODEC_NAMES: Record<number, string> = {
  0x68323634: "h264",
  0x68323635: "h265",
  0x00617631: "av1",
};

function parseVideoPreamble(buf: Buffer): {
  deviceName: string;
  codecName: string;
  width: number;
  height: number;
  extra: Buffer;
} {
  for (const offset of [0, 1]) {
    const codecMetaOffset = offset + 64;
    if (codecMetaOffset + 12 > buf.length) continue;
    const codecId = buf.readUInt32BE(codecMetaOffset);
    const width = buf.readUInt32BE(codecMetaOffset + 4);
    const height = buf.readUInt32BE(codecMetaOffset + 8);
    const codecName = CODEC_NAMES[codecId];
    if (!codecName || width < 1 || height < 1 || width > 16_384 || height > 16_384) continue;

    const nameBuf = buf.subarray(offset, offset + 64);
    const deviceName = nameBuf.toString("utf8").replace(/\0+$/, "");
    return {
      deviceName,
      codecName,
      width,
      height,
      extra: buf.subarray(codecMetaOffset + 12),
    };
  }

  throw new Error(`Could not parse scrcpy video preamble: ${buf.toString("hex", 0, 24)}...`);
}

export async function startScrcpy(opts: StartOpts): Promise<ScrcpySession> {
  const jar = await ensureScrcpyServer();
  const { serial } = opts;
  const maxFps = opts.maxFps ?? 60;
  const bitRate = opts.bitRate ?? 8_000_000;
  const maxSize = opts.maxSize ?? 0;
  const keyFrameInterval = opts.keyFrameInterval ?? 1;
  const scid = randomScid();
  let localPort: number | null = null;
  let proc: ChildProcess | null = null;
  let videoSock: Socket | null = null;
  let controlSock: Socket | null = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      videoSock?.destroy();
    } catch {}
    try {
      controlSock?.destroy();
    } catch {}
    try {
      proc?.kill("SIGKILL");
    } catch {}
    if (localPort !== null) {
      try {
        removeForward(serial, localPort);
      } catch {}
    }
  };

  try {
    adb(serial, ["push", jar, DEVICE_JAR_PATH]);
    localPort = forwardAbstractSocket(serial, scid);

    proc = spawn(
      "adb",
      [
        "-s",
        serial,
        "shell",
        `CLASSPATH=${DEVICE_JAR_PATH}`,
        "app_process",
        "/",
        "com.genymobile.scrcpy.Server",
        SCRCPY_VERSION,
        `scid=${scid}`,
        "log_level=info",
        "audio=false",
        "tunnel_forward=true",
        "control=true",
        "send_dummy_byte=true",
        "send_codec_meta=true",
        "send_frame_meta=true",
        "send_device_meta=true",
        `max_size=${maxSize}`,
        `video_bit_rate=${bitRate}`,
        `max_fps=${maxFps}`,
        ...(keyFrameInterval > 0 ? [`video_codec_options=i-frame-interval=${keyFrameInterval}`] : []),
        "cleanup=true",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    proc.stdout?.on("data", (b: Buffer) => process.stdout.write(`[scrcpy] ${b}`));
    proc.stderr?.on("data", (b: Buffer) => process.stderr.write(`[scrcpy] ${b}`));

    // Wait for the device-side abstract socket to appear before the host dials in;
    // otherwise adb accepts the local connection, then closes it the moment the
    // device-side connect fails, and the client sees a phantom EOF.
    await waitForAbstractSocket(serial, `scrcpy_${scid}`);

    // scrcpy in tunnel_forward mode waits for ALL configured sockets to be
    // connected before it begins streaming. Open both, then read the video
    // preamble.
    videoSock = await connectOnce(localPort);
    controlSock = await connectOnce(localPort);

    // After dummy byte, scrcpy may push clipboard events on the control socket;
    // drain them.
    controlSock.on("data", () => {});

    const reader = new FramedReader(videoSock);
    // scrcpy variants disagree on whether the video socket includes the dummy
    // byte, so detect the codec metadata alignment instead of blindly skipping.
    const preamble = parseVideoPreamble(await reader.read(77));
    reader.prepend(preamble.extra);

    return {
      transport: "scrcpy",
      meta: {
        deviceName: preamble.deviceName,
        codecId: preamble.codecName,
        width: preamble.width,
        height: preamble.height,
      },
      videoReader: reader,
      controlSocket: controlSock,
      proc,
      scid,
      localPort,
      serial,
      readFrame: () => readFrame(reader),
      close,
    };
  } catch (err) {
    close();
    throw err;
  }
}

/**
 * Read one frame from the scrcpy video stream.
 * Returns null when the stream ends. `isConfig` marks SPS/PPS bundles.
 */
const PACKET_FLAG_CONFIG = 1n << 63n;
const PACKET_FLAG_KEY_FRAME = 1n << 62n;
const PACKET_FLAGS = PACKET_FLAG_CONFIG | PACKET_FLAG_KEY_FRAME;

export async function readFrame(
  reader: FramedReader,
): Promise<VideoFrame | null> {
  try {
    const header = await reader.read(12);
    const ptsRaw = header.readBigUInt64BE(0);
    const size = header.readUInt32BE(8);
    const isConfig = (ptsRaw & PACKET_FLAG_CONFIG) !== 0n;
    const isKey = (ptsRaw & PACKET_FLAG_KEY_FRAME) !== 0n;
    const pts = ptsRaw & ~PACKET_FLAGS;
    const data = await reader.read(size);
    return { data, pts, isConfig, isKey };
  } catch {
    return null;
  }
}
