import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { VideoFrame } from "./scrcpy.ts";

/**
 * Host-side H.264 encoder for the grpc backend: raw RGB frames in via stdin,
 * scrcpy-compatible VideoFrames out (standalone SPS/PPS "config" packets plus
 * Annex-B access units), so the middleware fan-out and the WebCodecs client
 * are byte-compatible with the scrcpy path.
 *
 * ffmpeg/libx264 runs with zerolatency (no lookahead, no B-frames), which
 * keeps input frame N ↔ output access unit N strictly 1:1 and in order — that
 * pairing is what lets us attach PTS values from a simple queue. `aud=1`
 * inserts Access Unit Delimiter NALs so the byte stream can be split into
 * access units without parsing slice headers.
 */

export type H264EncoderOpts = {
  width: number;
  height: number;
  fps: number;
  bitRate: number;
  /** Seconds between forced keyframes; 0 leaves it to the encoder (matches scrcpy). */
  keyFrameInterval: number;
  onFrame: (frame: VideoFrame) => void;
  /** Fired only for unexpected exits (not close()). */
  onExit: (reason: string) => void;
};

const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;
const START_CODE = Buffer.from([0, 0, 0, 1]);

type Nal = { pos: number; dataPos: number; type: number };

export function resolveFfmpeg(): string {
  return process.env.SERVE_EMU_FFMPEG || "ffmpeg";
}

export function assertFfmpegAvailable(): void {
  const r = spawnSync(resolveFfmpeg(), ["-version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    throw new Error(
      `ffmpeg not found (tried "${resolveFfmpeg()}"); the grpc backend encodes H.264 on the host — install ffmpeg or point SERVE_EMU_FFMPEG at a binary`,
    );
  }
}

export class H264Encoder {
  readonly width: number;
  readonly height: number;
  private readonly opts: H264EncoderOpts;
  private proc: ChildProcess;
  private closed = false;
  private pending: Buffer = Buffer.alloc(0);
  private scanFrom = 0;
  private nals: Nal[] = [];
  private ptsQueue: bigint[] = [];
  private lastPts = 0n;
  private lastConfig: Buffer | null = null;

  constructor(opts: H264EncoderOpts) {
    this.opts = opts;
    this.width = opts.width;
    this.height = opts.height;
    const keyint =
      opts.keyFrameInterval > 0 ? Math.max(1, Math.round(opts.fps * opts.keyFrameInterval)) : 250;
    const x264Params = [
      `keyint=${keyint}`,
      `min-keyint=${keyint}`,
      "scenecut=0",
      "repeat-headers=1",
      "aud=1",
    ].join(":");

    this.proc = spawn(
      resolveFfmpeg(),
      [
        "-hide_banner",
        "-loglevel", "error",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "-video_size", `${opts.width}x${opts.height}`,
        "-framerate", String(opts.fps),
        "-i", "pipe:0",
        "-an",
        // yuv420p needs even dimensions; the crop is a no-op when already even.
        "-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2",
        "-pix_fmt", "yuv420p",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-profile:v", "baseline",
        "-b:v", String(opts.bitRate),
        "-maxrate", String(opts.bitRate),
        "-bufsize", String(opts.bitRate),
        "-x264-params", x264Params,
        "-f", "h264",
        "-flush_packets", "1",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    this.proc.stdout!.on("data", (chunk: Buffer) => this.append(chunk));
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.warn(`serve-emu ffmpeg: ${text}`);
    });
    this.proc.stdin!.on("error", () => {}); // EPIPE during teardown
    this.proc.once("error", (err) => {
      if (!this.closed) this.opts.onExit(`ffmpeg failed to start: ${err.message}`);
    });
    this.proc.once("exit", (code, signal) => {
      if (!this.closed) {
        this.opts.onExit(`ffmpeg exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
      }
    });
  }

  /** Feed one rgb24 frame (must be width×height×3 bytes). */
  write(rgb: Buffer, ptsUs: bigint): void {
    if (this.closed || !this.proc.stdin?.writable) return;
    this.ptsQueue.push(ptsUs);
    this.proc.stdin.write(rgb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.stdin?.destroy();
    } catch {}
    try {
      this.proc.kill("SIGKILL");
    } catch {}
  }

  private append(chunk: Buffer): void {
    if (this.closed) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.scanNals();
    this.emitCompleteAccessUnits();
  }

  // Record the start/type of every NAL unit in `pending`. Resumes a few bytes
  // before the previous scan end so start codes split across chunks are found.
  private scanNals(): void {
    const buf = this.pending;
    const lastFound = this.nals.length ? this.nals[this.nals.length - 1].pos : -1;
    let i = Math.max(0, this.scanFrom - 4);
    while (i + 3 < buf.length) {
      if (buf[i] !== 0 || buf[i + 1] !== 0) {
        i++;
        continue;
      }
      let dataPos = -1;
      if (buf[i + 2] === 1) dataPos = i + 3;
      else if (buf[i + 2] === 0 && buf[i + 3] === 1) dataPos = i + 4;
      if (dataPos === -1) {
        i++;
        continue;
      }
      if (dataPos >= buf.length) break; // NAL type byte not received yet
      if (i > lastFound) this.nals.push({ pos: i, dataPos, type: buf[dataPos] & 0x1f });
      i = dataPos + 1;
    }
    this.scanFrom = Math.max(0, buf.length - 4);
  }

  // An access unit spans from one AUD (exclusive) to the next AUD; the final
  // AU stays pending until the next one begins, so callers chase "real" frames
  // with a repeat write to flush them (see grpc-session.ts).
  private emitCompleteAccessUnits(): void {
    let lastAud = -1;
    for (let n = 0; n < this.nals.length; n++) {
      if (this.nals[n].type !== NAL_AUD) continue;
      if (lastAud >= 0) this.emitAccessUnit(this.nals.slice(lastAud + 1, n), this.nals[n].pos);
      lastAud = n;
    }
    if (lastAud < 0) return;
    const base = this.nals[lastAud].pos;
    this.nals = this.nals.slice(lastAud);
    if (base > 0) {
      this.pending = this.pending.subarray(base);
      for (const nal of this.nals) {
        nal.pos -= base;
        nal.dataPos -= base;
      }
      this.scanFrom = Math.max(0, this.scanFrom - base);
    }
  }

  private emitAccessUnit(units: Nal[], endPos: number): void {
    if (!units.length) return;
    let isKey = false;
    const config: Buffer[] = [];
    const frame: Buffer[] = [];
    for (let i = 0; i < units.length; i++) {
      const nal = units[i];
      const end = i + 1 < units.length ? units[i + 1].pos : endPos;
      const payload = this.pending.subarray(nal.dataPos, end);
      if (nal.type === NAL_SPS || nal.type === NAL_PPS) {
        config.push(START_CODE, payload);
      } else {
        if (nal.type === NAL_IDR) isKey = true;
        frame.push(START_CODE, payload);
      }
    }
    // Standalone SPS/PPS packet, like scrcpy's config packets; repeat-headers=1
    // re-emits them before every IDR but we forward only actual changes.
    if (config.length) {
      const configBuf = Buffer.concat(config);
      if (!this.lastConfig || !this.lastConfig.equals(configBuf)) {
        this.lastConfig = configBuf;
        this.opts.onFrame({ data: configBuf, pts: this.lastPts, isConfig: true, isKey: false });
      }
    }
    if (!frame.length) return;
    const pts = this.ptsQueue.shift() ?? this.lastPts + 33_333n;
    this.lastPts = pts;
    this.opts.onFrame({ data: Buffer.concat(frame), pts, isConfig: false, isKey });
  }
}
