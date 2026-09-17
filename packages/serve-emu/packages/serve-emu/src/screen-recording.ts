import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from "mediabunny";
import { createRecordingFileTarget } from "./recording-file-target.ts";
import type { VideoPacket } from "./scrcpy.ts";

type RecordingMetadata = {
  udid: string;
  deviceName: string;
  runtimeDisplayName: string;
};

export class ScreenRecordingConflictError extends Error {}

export type ScreenRecordingResult = RecordingMetadata & { directory: string };

export type ScreenRecordingStatus =
  | { status: "waiting" }
  | { status: "recording"; firstFrameAt: string; frames: number; queuedBytes: number }
  | { status: "finalizing" }
  | { status: "complete" }
  | { status: "failed"; error: string };

type Sample = {
  data: Buffer;
  isKey: boolean;
  timeUs: bigint;
};

export type RecordingWriter = {
  add(sample: { data: Buffer; isKey: boolean; timestamp: number; duration: number }): Promise<void>;
  finish(): Promise<void>;
  cancel(): Promise<void>;
};

export const DEFAULT_RECORDING_LIMITS = {
  // Above one hour at 6 Mbps, so the duration limit finalizes before the byte limit fails.
  maxFileBytes: 4 * 1024 ** 3,
  maxDurationMs: 60 * 60 * 1000,
  minFreeBytes: 256 * 1024 ** 2,
};
type WriterOptions = {
  path: string;
  codec: string;
  width: number;
  height: number;
  maxFileBytes: number;
  minFreeBytes: number;
};

export type RecordingOptions = RecordingMetadata & {
  directory: string;
  maxQueuedBytes?: number;
  maxFileBytes?: number;
  maxDurationMs?: number;
  minFreeBytes?: number;
  /** Bound on finish(); a stalled writer fails the recording instead of hanging shutdown. */
  finalizeTimeoutMs?: number;
  /** Test seam. Production uses a host monotonic clock paired with epoch time. */
  clock?: { monotonicUs(): bigint; epochMs(): number };
  createWriter?: (options: WriterOptions) => Promise<RecordingWriter>;
};

async function createMp4Writer(options: WriterOptions): Promise<RecordingWriter> {
  const file = await createRecordingFileTarget(options);
  const output = new Output({
    // Each closed fragment plays on its own, so a crash keeps everything before the open one.
    format: new Mp4OutputFormat({ fastStart: "fragmented" }),
    target: file.target,
  });
  const source = new EncodedVideoPacketSource("avc");
  output.addVideoTrack(source);
  try {
    await output.start();
  } catch (error) {
    await file.close();
    throw error;
  }
  let sequence = 0;
  return {
    async add(sample) {
      const first = sequence === 0;
      await source.add(
        new EncodedPacket(
          sample.data,
          sample.isKey ? "key" : "delta",
          sample.timestamp,
          sample.duration,
          sequence++,
        ),
        first
          ? {
              decoderConfig: {
                codec: options.codec,
                codedWidth: options.width,
                codedHeight: options.height,
              },
            }
          : undefined,
      );
    },
    finish: async () => {
      try {
        await output.finalize();
      } finally {
        await file.close();
      }
    },
    cancel: async () => {
      try {
        await output.cancel();
      } finally {
        await file.close();
      }
    },
  };
}

function parameterSets(data: Buffer): { sps: Buffer | null; pps: Buffer | null } {
  let sps: Buffer | null = null;
  let pps: Buffer | null = null;
  const starts: { start: number; payload: number }[] = [];
  for (let i = 0; i + 3 <= data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    const length = data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0;
    if (!length) continue;
    starts.push({ start: i, payload: i + length });
    i += length - 1;
  }
  for (const [i, start] of starts.entries()) {
    const nal = data.subarray(start.payload, starts[i + 1]?.start ?? data.length);
    if ((nal[0] & 31) === 7) sps = Buffer.from(nal);
    if ((nal[0] & 31) === 8) pps = Buffer.from(nal);
  }
  return { sps, pps };
}

/** One capture generation. Failure is isolated from preview; only finish publishes an artifact. */
export class ScreenRecording {
  readonly #options: RecordingOptions;
  readonly #clock: NonNullable<RecordingOptions["clock"]>;
  readonly #maxQueuedBytes: number;
  #status: ScreenRecordingStatus = { status: "waiting" };
  #sps: Buffer | null = null;
  #pps: Buffer | null = null;
  #pending: Sample | null = null;
  #first: {
    pts: bigint;
    monotonicUs: bigint;
    epochMs: number;
    width: number;
    height: number;
  } | null = null;
  #writer: RecordingWriter | null = null;
  #writes: Promise<void> = Promise.resolve();
  #manifestWrites: Promise<void> = Promise.resolve();
  #queuedBytes = 0;
  #frames = 0;
  #durationTimer: ReturnType<typeof setTimeout> | null = null;
  #stopReason: "session-stop" | "duration-limit" = "session-stop";
  #outputName = "recording.mp4.partial";
  readonly #limits: typeof DEFAULT_RECORDING_LIMITS;
  #finishTask: Promise<ScreenRecordingResult> | null = null;
  #failureTask: Promise<void> | null = null;
  #failureManifest: Promise<void> | null = null;
  #readyResolve!: () => void;
  #readyReject!: (reason: Error) => void;
  readonly ready: Promise<void>;

  private constructor(options: RecordingOptions) {
    this.#options = options;
    this.#limits = {
      maxFileBytes: options.maxFileBytes ?? DEFAULT_RECORDING_LIMITS.maxFileBytes,
      maxDurationMs: options.maxDurationMs ?? DEFAULT_RECORDING_LIMITS.maxDurationMs,
      minFreeBytes: options.minFreeBytes ?? DEFAULT_RECORDING_LIMITS.minFreeBytes,
    };
    this.#clock = options.clock ?? {
      monotonicUs: () => BigInt(Math.round(performance.now() * 1000)),
      epochMs: () => Date.now(),
    };
    this.#maxQueuedBytes = options.maxQueuedBytes ?? 16 * 1024 * 1024;
    this.ready = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    void this.ready.catch(() => {});
  }

  static async create(options: RecordingOptions): Promise<ScreenRecording> {
    for (const [name, value] of Object.entries({
      maxFileBytes: options.maxFileBytes,
      maxDurationMs: options.maxDurationMs,
      minFreeBytes: options.minFreeBytes,
    })) {
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) ||
          value < (name === "minFreeBytes" ? 0 : 1) ||
          (name === "maxDurationMs" && value > 86_400_000))
      ) {
        throw new Error(`Invalid recording limit ${name}.`);
      }
    }
    // The caller supplies a fresh session directory. Never overwrite another recording.
    await mkdir(options.directory, { recursive: false });
    const recording = new ScreenRecording(options);
    await recording.#manifest({ status: "waiting" });
    return recording;
  }

  get active(): boolean {
    return this.#status.status === "waiting" || this.#status.status === "recording";
  }

  snapshot(): ScreenRecordingStatus {
    if (this.#status.status === "recording" && this.#first) {
      return {
        status: "recording",
        firstFrameAt: new Date(this.#first.epochMs).toISOString(),
        frames: this.#frames,
        queuedBytes: this.#queuedBytes,
      };
    }
    return { ...this.#status };
  }

  accept(
    packet: VideoPacket,
    size: { width: number; height: number },
    source: "scrcpy" | "grpc-screenshot",
  ): void {
    if (!this.active) return;
    try {
      if (packet.type === "session") {
        if (
          this.#first &&
          (packet.width !== this.#first.width || packet.height !== this.#first.height)
        ) {
          this.fail(new Error("Recording does not support display size changes yet."));
        }
        return;
      }
      const sets = parameterSets(packet.data);
      for (const [previous, next] of [
        [this.#sps, sets.sps],
        [this.#pps, sets.pps],
      ]) {
        if (this.#first && previous && next && !previous.equals(next)) {
          this.fail(new Error("Recording does not support codec configuration changes yet."));
          return;
        }
      }
      this.#sps = sets.sps ?? this.#sps;
      this.#pps = sets.pps ?? this.#pps;
      if (packet.isConfig) return;
      if (!this.#first) {
        if (!packet.isKey || !this.#sps || !this.#pps) return;
        if (this.#sps.length < 4 || size.width <= 0 || size.height <= 0)
          throw new Error("Invalid recording codec configuration.");
        const monotonicUs = this.#clock.monotonicUs();
        // gRPC packets use this process's encoder-submission clock, including idle repeats.
        const captureDelayMs =
          source === "grpc-screenshot" ? Number(monotonicUs - packet.pts) / 1000 : 0;
        this.#first = {
          pts: packet.pts,
          monotonicUs: monotonicUs - BigInt(Math.round(captureDelayMs * 1000)),
          epochMs: this.#clock.epochMs() - captureDelayMs,
          ...size,
        };
        const config = Buffer.concat([
          Buffer.from([0, 0, 0, 1]),
          this.#sps,
          Buffer.from([0, 0, 0, 1]),
          this.#pps,
        ]);
        const codec = `avc1.${this.#sps.subarray(1, 4).toString("hex")}`;
        this.#writes = (this.#options.createWriter ?? createMp4Writer)({
          path: join(this.#options.directory, "recording.mp4.partial"),
          codec,
          ...size,
          maxFileBytes: this.#limits.maxFileBytes,
          minFreeBytes: this.#limits.minFreeBytes,
        })
          .then((writer) => {
            this.#writer = writer;
            this.#readyResolve();
          })
          .catch((error) => this.fail(error));
        this.#pending = { data: Buffer.concat([config, packet.data]), isKey: true, timeUs: 0n };
        if (this.#pending.data.length > this.#maxQueuedBytes)
          throw new Error("Recording disk queue exceeded its byte limit.");
        this.#status = {
          status: "recording",
          firstFrameAt: new Date(this.#first.epochMs).toISOString(),
          frames: 0,
          queuedBytes: 0,
        };
        this.#frames = 1;
        // A killed process never reaches finish; this lets the uploader place the partial file.
        void this.#manifest({ status: "recording", ...this.#fileFields() }).catch((error) =>
          this.fail(error),
        );
        this.#durationTimer = setTimeout(
          () => this.#finishAtDurationLimit(),
          this.#limits.maxDurationMs,
        );
        this.#durationTimer.unref();
        return;
      }
      const timeUs = packet.pts - this.#first.pts;
      if (
        timeUs >= BigInt(this.#limits.maxDurationMs) * 1000n ||
        this.#clock.monotonicUs() - this.#first.monotonicUs >=
          BigInt(this.#limits.maxDurationMs) * 1000n
      ) {
        this.#finishAtDurationLimit();
        return;
      }
      if (!this.#pending || timeUs <= this.#pending.timeUs)
        throw new Error("Recording source timestamps stopped increasing.");
      this.#enqueue(this.#pending, timeUs - this.#pending.timeUs);
      this.#throwIfFailed();
      this.#pending = { data: Buffer.from(packet.data), isKey: packet.isKey, timeUs };
      this.#frames++;
      if (this.#queuedBytes + this.#pending.data.length > this.#maxQueuedBytes)
        throw new Error("Recording disk queue exceeded its byte limit.");
    } catch (error) {
      this.fail(error);
    }
  }

  #finishAtDurationLimit(): void {
    if (!this.active) return;
    this.#stopReason = "duration-limit";
    void this.finish().catch(() => {});
  }

  fail(reason: unknown): void {
    if (this.#status.status === "complete" || this.#status.status === "failed") return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    if (this.#durationTimer) clearTimeout(this.#durationTimer);
    this.#status = { status: "failed", error: error.message };
    this.#pending = null;
    this.#readyReject(error);
    // The manifest does not wait for the writer: a stalled write chain must still leave the failure on disk.
    this.#failureManifest = this.#manifest({
      status: "failed",
      error: error.message,
      ...this.#fileFields(),
    }).catch(() => {});
    // Drain already scheduled writes before closing their file handle.
    this.#failureTask = Promise.allSettled([
      this.#failureManifest,
      this.#writes.then(() => this.#writer?.cancel()),
    ]).then(() => {});
  }

  /** Where the frames are and how to place them, once the first keyframe arrived. */
  #fileFields(): Record<string, unknown> {
    if (!this.#first) return {};
    return {
      recording: this.#outputName,
      firstFrameWallClock: { iso8601: new Date(this.#first.epochMs).toISOString() },
      width: this.#first.width,
      height: this.#first.height,
    };
  }

  finish(): Promise<ScreenRecordingResult> {
    if (this.#finishTask) return this.#finishTask;
    if (this.#durationTimer) clearTimeout(this.#durationTimer);
    this.#finishTask = this.#finish();
    return this.#finishTask;
  }

  async #finish(): Promise<ScreenRecordingResult> {
    if (!this.#first || !this.#pending || this.#status.status === "failed") {
      const error = new Error(
        this.#status.status === "failed"
          ? this.#status.error
          : "Recording received no decodable frame.",
      );
      this.fail(error);
      await this.#failureTask;
      throw error;
    }
    const first = this.#first;
    const elapsedUs = this.#clock.monotonicUs() - first.monotonicUs;
    const durationUs =
      this.#stopReason === "duration-limit"
        ? BigInt(this.#limits.maxDurationMs) * 1000n
        : elapsedUs;
    this.#enqueue(
      this.#pending,
      durationUs > this.#pending.timeUs ? durationUs - this.#pending.timeUs : 1n,
    );
    this.#pending = null;
    const timeoutMs = this.#options.finalizeTimeoutMs ?? 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Recording finalization exceeded ${timeoutMs} ms.`)),
        timeoutMs,
      );
      timer.unref();
    });
    try {
      this.#throwIfFailed();
      this.#status = { status: "finalizing" };
      return await Promise.race([this.#finalize(durationUs), deadline]);
    } catch (error) {
      this.fail(error);
      // A stalled writer never drains; wait for the failure manifest only, and not past a bound.
      await Promise.race([
        this.#failureManifest,
        new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
      ]);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #finalize(durationUs: bigint): Promise<ScreenRecordingResult> {
    await this.#writes;
    this.#throwIfFailed();
    if (!this.#writer) throw new Error("Recording writer did not start.");
    await this.#writer.finish();
    this.#throwIfFailed();
    await rename(
      join(this.#options.directory, "recording.mp4.partial"),
      join(this.#options.directory, "recording.mp4"),
    );
    this.#outputName = "recording.mp4";
    this.#throwIfFailed();
    const { udid, deviceName, runtimeDisplayName, directory } = this.#options;
    const result = { udid, deviceName, runtimeDisplayName, directory };
    await this.#manifest({
      status: "complete",
      ...this.#fileFields(),
      durationSeconds: Number(durationUs) / 1e6,
      stopReason: this.#stopReason,
      frames: this.#frames,
    });
    this.#throwIfFailed();
    this.#status = { status: "complete" };
    return result;
  }

  #throwIfFailed(): void {
    if (this.#status.status === "failed") throw new Error(this.#status.error);
  }

  #enqueue(sample: Sample, durationUs: bigint): void {
    if (this.#queuedBytes + sample.data.length > this.#maxQueuedBytes) {
      this.fail(new Error("Recording disk queue exceeded its byte limit."));
      return;
    }
    this.#queuedBytes += sample.data.length;
    this.#writes = this.#writes
      .then(async () => {
        if (this.#status.status === "failed") return;
        if (!this.#writer) throw new Error("Recording writer did not start.");
        await this.#writer.add({
          data: sample.data,
          isKey: sample.isKey,
          timestamp: Number(sample.timeUs) / 1e6,
          duration: Number(durationUs) / 1e6,
        });
        this.#readyResolve();
      })
      .catch((error) => this.fail(error))
      .finally(() => {
        this.#queuedBytes -= sample.data.length;
      });
  }

  #manifest(fields: Record<string, unknown>): Promise<void> {
    const task = this.#manifestWrites.then(async () => {
      const { udid, deviceName, runtimeDisplayName } = this.#options;
      const path = join(this.#options.directory, "session.json");
      await writeFile(
        `${path}.partial`,
        JSON.stringify({ version: 1, udid, deviceName, runtimeDisplayName, ...fields }, null, 2),
      );
      await rename(`${path}.partial`, path);
    });
    this.#manifestWrites = task.catch(() => {});
    return task;
  }
}
