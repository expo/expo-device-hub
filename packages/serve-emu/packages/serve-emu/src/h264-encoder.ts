import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  execText,
  type ExecOpts,
  type ExecResult,
} from "./exec.ts";
import type { VideoFrame } from "./scrcpy.ts";

/**
 * Host-side H.264 encoder used by the emulator gRPC screenshot source.
 *
 * RGB frames or complete PNG images enter through stdin and ffmpeg/libx264
 * writes Annex-B H.264 to stdout. `aud=1` gives the parser an explicit
 * access-unit boundary, while zerolatency and disabled B-frames keep input
 * timestamps paired with output access units in submission order.
 */

export type H264EncoderInputFormat = "rgb24" | "png";

export type H264EncoderOpts = {
  width: number;
  height: number;
  /** Input written to ffmpeg. Defaults to fixed-size raw RGB frames. */
  inputFormat?: H264EncoderInputFormat;
  /** Android display rotation quarter turns applied before encoding. */
  quarterTurn?: QuarterTurn;
  fps: number;
  bitRate: number;
  /** Seconds between forced keyframes; 0 uses libx264's default keyint. */
  keyFrameInterval: number;
  onFrame: (frame: VideoFrame) => void;
  /** Called once when ffmpeg or its output parser fails unexpectedly. */
  onExit: (reason: string) => void;
};

export type QuarterTurn = 0 | 1 | 2 | 3;

const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;
const START_CODE = Buffer.from([0, 0, 0, 1]);
const MAX_PENDING_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_RAW_FRAME_BYTES = 512 * 1024 * 1024;
const MAX_PNG_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_DIMENSION = 16_384;
const MAX_FPS = 1_000;
const MAX_BIT_RATE = 0x7fff_ffff;
const PROCESS_GRACE_MS = 250;
const PROCESS_TERM_MS = 500;
const PROCESS_KILL_MS = 500;
const FFMPEG_PROBE_TIMEOUT_MS = 10_000;
const FFMPEG_PROBE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_FFMPEG_STDERR_BYTES = 16 * 1024;

/** Keeps only a bounded tail of subprocess diagnostics. */
export class FfmpegStderrTail {
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  append(chunk: Uint8Array): void {
    const incoming = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (incoming.length >= MAX_FFMPEG_STDERR_BYTES) {
      this.#buffer = Buffer.from(
        incoming.subarray(incoming.length - MAX_FFMPEG_STDERR_BYTES),
      );
      return;
    }
    const combined = this.#buffer.length
      ? Buffer.concat([this.#buffer, incoming])
      : incoming;
    this.#buffer = combined.length > MAX_FFMPEG_STDERR_BYTES
      ? Buffer.from(combined.subarray(combined.length - MAX_FFMPEG_STDERR_BYTES))
      : combined;
  }

  text(): string {
    return this.#buffer.toString("utf8").trim();
  }
}

type Nal = { pos: number; dataPos: number; type: number };

type H264OutputParserOpts = {
  fps: number;
  onFrame: (frame: VideoFrame) => void;
};

function finitePositive(value: number, name: string, max: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    throw new RangeError(`${name} must be greater than 0 and at most ${max}`);
  }
  return value;
}

function positiveInteger(value: number, name: string, max: number): number {
  finitePositive(value, name, max);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer`);
  }
  return value;
}

function validateOptions(opts: H264EncoderOpts): number | null {
  const width = positiveInteger(opts.width, "width", MAX_DIMENSION);
  const height = positiveInteger(opts.height, "height", MAX_DIMENSION);
  if (width < 2 || height < 2) {
    throw new RangeError("width and height must both be at least 2 pixels");
  }
  finitePositive(opts.fps, "fps", MAX_FPS);
  positiveInteger(opts.bitRate, "bitRate", MAX_BIT_RATE);
  if (
    !Number.isFinite(opts.keyFrameInterval) ||
    opts.keyFrameInterval < 0
  ) {
    throw new RangeError("keyFrameInterval must be a non-negative number");
  }
  const keyint = Math.round(opts.fps * opts.keyFrameInterval);
  if (!Number.isSafeInteger(keyint) || keyint > MAX_BIT_RATE) {
    throw new RangeError("fps × keyFrameInterval is too large");
  }
  if (typeof opts.onFrame !== "function" || typeof opts.onExit !== "function") {
    throw new TypeError("onFrame and onExit must be functions");
  }
  const quarterTurn = opts.quarterTurn ?? 0;
  if (!Number.isInteger(quarterTurn) || quarterTurn < 0 || quarterTurn > 3) {
    throw new RangeError("quarterTurn must be an integer from 0 through 3");
  }

  const inputFormat = opts.inputFormat ?? "rgb24";
  if (inputFormat !== "rgb24" && inputFormat !== "png") {
    throw new RangeError(`unsupported H.264 encoder input format ${inputFormat}`);
  }

  const bytes = width * height * 3;
  if (!Number.isSafeInteger(bytes) || bytes > MAX_RAW_FRAME_BYTES) {
    throw new RangeError(
      `raw RGB frame must not exceed ${MAX_RAW_FRAME_BYTES} bytes`,
    );
  }
  return inputFormat === "rgb24" ? bytes : null;
}

export function ffmpegInputArgs(
  inputFormat: H264EncoderInputFormat,
  width: number,
  height: number,
  fps: number,
): string[] {
  if (inputFormat === "png") {
    return [
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-max_probe_packets",
      "1",
      "-f",
      "image2pipe",
      "-framerate",
      String(fps),
      "-c:v",
      "png",
      "-i",
      "pipe:0",
    ];
  }
  if (inputFormat !== "rgb24") {
    throw new RangeError(`unsupported H.264 encoder input format ${inputFormat}`);
  }
  return [
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-video_size",
    `${width}x${height}`,
    "-framerate",
    String(fps),
    "-i",
    "pipe:0",
  ];
}

export function videoFilter(quarterTurn: QuarterTurn): string {
  const filters = ["crop=trunc(iw/2)*2:trunc(ih/2)*2"];
  if (quarterTurn === 1) filters.push("transpose=cclock");
  else if (quarterTurn === 2) filters.push("hflip", "vflip");
  else if (quarterTurn === 3) filters.push("transpose=clock");
  return filters.join(",");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Stateful, ffmpeg-independent parser for an Annex-B stream containing AUDs.
 *
 * The final access unit remains buffered until the next AUD arrives. This is
 * why the screenshot source chases a fresh RGB frame with a duplicate write:
 * the duplicate supplies the boundary needed to publish the fresh frame.
 */
export class H264OutputParser {
  readonly #onFrame: (frame: VideoFrame) => void;
  readonly #frameDurationUs: bigint;
  #pending: Buffer = Buffer.alloc(0);
  #scanFrom = 0;
  #nals: Nal[] = [];
  #ptsQueue: bigint[] = [];
  #lastPts = 0n;
  #lastConfig: Buffer | null = null;

  constructor(opts: H264OutputParserOpts) {
    finitePositive(opts.fps, "fps", MAX_FPS);
    if (typeof opts.onFrame !== "function") {
      throw new TypeError("onFrame must be a function");
    }
    this.#onFrame = opts.onFrame;
    this.#frameDurationUs = BigInt(Math.max(1, Math.round(1_000_000 / opts.fps)));
  }

  enqueuePts(ptsUs: bigint): void {
    if (typeof ptsUs !== "bigint" || ptsUs < 0n) {
      throw new RangeError("ptsUs must be a non-negative bigint");
    }
    this.#ptsQueue.push(ptsUs);
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    const incoming = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (this.#pending.length + incoming.length > MAX_PENDING_OUTPUT_BYTES) {
      throw new Error(
        `ffmpeg H.264 output exceeded ${MAX_PENDING_OUTPUT_BYTES} bytes without a complete access unit`,
      );
    }
    this.#pending = this.#pending.length
      ? Buffer.concat([this.#pending, incoming])
      : incoming;
    this.#scanNals();
    this.#emitCompleteAccessUnits();
  }

  #scanNals(): void {
    const lastDataPos = this.#nals.at(-1)?.dataPos ?? -1;
    let i = Math.max(0, this.#scanFrom - 4);
    while (i + 3 < this.#pending.length) {
      if (this.#pending[i] !== 0 || this.#pending[i + 1] !== 0) {
        i++;
        continue;
      }

      let dataPos = -1;
      if (this.#pending[i + 2] === 1) dataPos = i + 3;
      else if (
        this.#pending[i + 2] === 0 &&
        this.#pending[i + 3] === 1
      ) {
        dataPos = i + 4;
      }
      if (dataPos === -1) {
        i++;
        continue;
      }
      if (dataPos >= this.#pending.length) break;
      // A four-byte start code also contains a three-byte start code beginning
      // one byte later. Compare the payload position so an overlap rescan
      // cannot record that same NAL twice across a chunk boundary.
      if (dataPos > lastDataPos) {
        this.#nals.push({
          pos: i,
          dataPos,
          type: this.#pending[dataPos]! & 0x1f,
        });
      }
      i = dataPos + 1;
    }
    this.#scanFrom = Math.max(0, this.#pending.length - 4);
  }

  #emitCompleteAccessUnits(): void {
    let lastAud = -1;
    for (let index = 0; index < this.#nals.length; index++) {
      if (this.#nals[index]!.type !== NAL_AUD) continue;
      if (lastAud >= 0) {
        this.#emitAccessUnit(
          this.#nals.slice(lastAud + 1, index),
          this.#nals[index]!.pos,
        );
      }
      lastAud = index;
    }
    if (lastAud < 0) return;

    const base = this.#nals[lastAud]!.pos;
    this.#nals = this.#nals.slice(lastAud);
    if (base === 0) return;
    this.#pending = this.#pending.subarray(base);
    for (const nal of this.#nals) {
      nal.pos -= base;
      nal.dataPos -= base;
    }
    this.#scanFrom = Math.max(0, this.#scanFrom - base);
  }

  #emitAccessUnit(units: Nal[], endPos: number): void {
    if (units.length === 0) return;
    let isKey = false;
    const config: Buffer[] = [];
    const frame: Buffer[] = [];
    for (let index = 0; index < units.length; index++) {
      const nal = units[index]!;
      const end = units[index + 1]?.pos ?? endPos;
      const payload = this.#pending.subarray(nal.dataPos, end);
      if (nal.type === NAL_SPS || nal.type === NAL_PPS) {
        config.push(START_CODE, payload);
      } else {
        if (nal.type === NAL_IDR) isKey = true;
        frame.push(START_CODE, payload);
      }
    }

    if (config.length > 0) {
      const nextConfig = Buffer.concat(config);
      if (!this.#lastConfig?.equals(nextConfig)) {
        this.#lastConfig = nextConfig;
        this.#onFrame({
          type: "frame",
          data: nextConfig,
          pts: this.#lastPts,
          isConfig: true,
          isKey: false,
        });
      }
    }
    if (frame.length === 0) return;

    const pts = this.#ptsQueue.shift() ?? this.#lastPts + this.#frameDurationUs;
    this.#lastPts = pts;
    this.#onFrame({
      type: "frame",
      data: Buffer.concat(frame),
      pts,
      isConfig: false,
      isKey,
    });
  }
}

export function resolveFfmpeg(): string {
  return process.env.SERVE_EMU_FFMPEG?.trim() || "ffmpeg";
}

export type FfmpegProbeRunner = (
  binary: string,
  args: string[],
  options: ExecOpts,
) => Promise<ExecResult<string>>;

export type FfmpegAvailabilityProbeOptions = {
  resolveBinary?: () => string;
  runExec?: FfmpegProbeRunner;
};

function probeAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("ffmpeg capability probe aborted", "AbortError");
}

/**
 * Build an asynchronous, abortable capability check which caches successes.
 * Failures are deliberately retryable so installing ffmpeg/libx264 does not
 * require restarting serve-emu.
 */
export function createFfmpegAvailabilityProbe(
  options: FfmpegAvailabilityProbeOptions = {},
): (signal?: AbortSignal) => Promise<void> {
  const resolveBinary = options.resolveBinary ?? resolveFfmpeg;
  const runExec = options.runExec ?? execText;
  const available = new Set<string>();

  return async (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) throw probeAbortReason(signal);
    const binary = resolveBinary();
    if (available.has(binary)) return;

    const result = await runExec(
      binary,
      ["-hide_banner", "-encoders"],
      {
        timeout: FFMPEG_PROBE_TIMEOUT_MS,
        maxBuffer: FFMPEG_PROBE_MAX_BYTES,
        signal,
        lane: "background",
      },
    );
    if (signal?.aborted) throw probeAbortReason(signal);
    if (result.error || result.status !== 0) {
      const detail = result.timedOut
        ? `capability probe timed out after ${FFMPEG_PROBE_TIMEOUT_MS}ms`
        : result.error?.message ||
          result.stderr.trim() ||
          `exit ${result.status}`;
      throw new Error(
        `ffmpeg not found or unusable (tried "${binary}"): ${detail}`,
      );
    }
    if (!/\blibx264\b/.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error(
        `ffmpeg at "${binary}" does not include the libx264 encoder required by the grpc backend`,
      );
    }
    available.add(binary);
  };
}

export const assertFfmpegAvailable = createFfmpegAvailabilityProbe();

export class H264Encoder {
  readonly width: number;
  readonly height: number;
  readonly quarterTurn: QuarterTurn;
  readonly encodedWidth: number;
  readonly encodedHeight: number;
  readonly inputFormat: H264EncoderInputFormat;
  readonly #opts: H264EncoderOpts;
  readonly #proc: ChildProcessWithoutNullStreams;
  readonly #parser: H264OutputParser;
  readonly #inputFrameBytes: number | null;
  readonly #processDone: Promise<void>;
  readonly #stderr = new FfmpegStderrTail();
  #resolveProcessDone!: () => void;
  #closed = false;
  #failureReported = false;
  #closeTask: Promise<void> | null = null;

  constructor(opts: H264EncoderOpts) {
    this.#inputFrameBytes = validateOptions(opts);
    this.#opts = opts;
    this.width = opts.width;
    this.height = opts.height;
    this.inputFormat = opts.inputFormat ?? "rgb24";
    this.quarterTurn = opts.quarterTurn ?? 0;
    const croppedWidth = opts.width - (opts.width % 2);
    const croppedHeight = opts.height - (opts.height % 2);
    const transposed = this.quarterTurn === 1 || this.quarterTurn === 3;
    this.encodedWidth = transposed ? croppedHeight : croppedWidth;
    this.encodedHeight = transposed ? croppedWidth : croppedHeight;
    this.#parser = new H264OutputParser({
      fps: opts.fps,
      onFrame: opts.onFrame,
    });
    this.#processDone = new Promise((resolve) => {
      this.#resolveProcessDone = resolve;
    });

    const keyint = opts.keyFrameInterval > 0
      ? Math.max(1, Math.round(opts.fps * opts.keyFrameInterval))
      : 250;
    const x264Params = [
      `keyint=${keyint}`,
      `min-keyint=${keyint}`,
      "scenecut=0",
      "repeat-headers=1",
      "aud=1",
    ].join(":");

    this.#proc = spawn(
      resolveFfmpeg(),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        ...ffmpegInputArgs(
          this.inputFormat,
          opts.width,
          opts.height,
          opts.fps,
        ),
        "-an",
        "-vf",
        videoFilter(this.quarterTurn),
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-profile:v",
        "baseline",
        "-b:v",
        String(opts.bitRate),
        "-maxrate",
        String(opts.bitRate),
        "-bufsize",
        String(opts.bitRate),
        "-x264-params",
        x264Params,
        "-f",
        "h264",
        "-flush_packets",
        "1",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    this.#proc.stdout.on("data", (chunk: Buffer) => this.#append(chunk));
    this.#proc.stdout.once("error", (error) => {
      this.#reportFailure(`ffmpeg stdout failed: ${error.message}`);
    });
    this.#proc.stderr.on("data", (chunk: Buffer) => {
      this.#stderr.append(chunk);
      const text = chunk.toString("utf8").trim();
      if (text) console.warn(`serve-emu ffmpeg: ${text}`);
    });
    this.#proc.stdin.once("error", (error) => {
      this.#reportFailure(`ffmpeg stdin failed: ${error.message}`);
    });
    this.#proc.once("error", (error) => {
      this.#reportFailure(`ffmpeg failed to start: ${error.message}`);
      this.#resolveProcessDone();
    });
    this.#proc.once("close", (code, signal) => {
      if (!this.#closed) {
        const stderr = this.#stderr.text();
        this.#reportFailure(
          `ffmpeg exited with code ${code ?? "null"} signal ${signal ?? "null"}${stderr ? `: ${stderr}` : ""}`,
        );
      }
      this.#resolveProcessDone();
    });
  }

  /** Feed one complete source image; false means backpressure rejected it. */
  write(image: Buffer, ptsUs: bigint): boolean {
    if (!Buffer.isBuffer(image)) {
      throw new TypeError("encoder input must be a Buffer");
    }
    if (
      this.inputFormat === "rgb24" &&
      image.length !== this.#inputFrameBytes
    ) {
      throw new RangeError(
        `rgb frame must be a ${this.#inputFrameBytes}-byte Buffer (${this.width}x${this.height} rgb24)`,
      );
    }
    if (
      this.inputFormat === "png" &&
      (image.length < 8 ||
        image.length > MAX_PNG_FRAME_BYTES ||
        !image.subarray(0, 8).equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        ))
    ) {
      throw new RangeError(
        `png frame must be a complete PNG Buffer of at most ${MAX_PNG_FRAME_BYTES} bytes`,
      );
    }
    if (typeof ptsUs !== "bigint" || ptsUs < 0n) {
      throw new RangeError("ptsUs must be a non-negative bigint");
    }
    if (
      this.#closed ||
      !this.#proc.stdin.writable ||
      this.#proc.stdin.writableNeedDrain
    ) {
      return false;
    }
    try {
      // A false return from Writable.write means "accepted, wait for drain",
      // not "rejected", so every successful call receives a PTS entry.
      this.#proc.stdin.write(image);
      this.#parser.enqueuePts(ptsUs);
      return true;
    } catch (error) {
      this.#reportFailure(
        `ffmpeg input write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /** Idempotently stop ffmpeg, escalating to SIGKILL without hanging shutdown. */
  close(): Promise<void> {
    if (this.#closeTask) return this.#closeTask;
    this.#closed = true;
    this.#closeTask = this.#shutdown();
    return this.#closeTask;
  }

  #append(chunk: Buffer): void {
    if (this.#closed) return;
    try {
      this.#parser.push(chunk);
    } catch (error) {
      this.#reportFailure(
        `failed to parse ffmpeg H.264 output: ${error instanceof Error ? error.message : String(error)}`,
      );
      void this.close();
    }
  }

  #reportFailure(reason: string): void {
    if (this.#closed || this.#failureReported) return;
    this.#failureReported = true;
    try {
      this.#opts.onExit(reason);
    } catch {}
  }

  async #shutdown(): Promise<void> {
    if (this.#proc.exitCode !== null || this.#proc.signalCode !== null) {
      await this.#processDone;
      return;
    }

    try {
      this.#proc.stdin.end();
    } catch {}
    if (await this.#waitForExit(PROCESS_GRACE_MS)) return;

    try {
      this.#proc.kill("SIGTERM");
    } catch {}
    if (await this.#waitForExit(PROCESS_TERM_MS)) return;

    try {
      this.#proc.kill("SIGKILL");
    } catch {}
    await this.#waitForExit(PROCESS_KILL_MS);
  }

  async #waitForExit(timeoutMs: number): Promise<boolean> {
    let exited = false;
    await Promise.race([
      this.#processDone.then(() => {
        exited = true;
      }),
      wait(timeoutMs),
    ]);
    return exited;
  }
}
