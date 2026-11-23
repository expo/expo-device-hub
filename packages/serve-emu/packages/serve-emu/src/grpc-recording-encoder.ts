import type { H264EncoderInputFormat, H264EncoderOpts } from "./h264-encoder.ts";
import {
  recordingGeometry,
  type RecordingCanvas,
  type RecordingGeometry,
} from "./recording-canvas.ts";
import type { VideoPacket } from "./scrcpy.ts";

/** Where a gRPC session sends a foldable's recording, encoded on its own fixed canvas. */
export type GrpcRecordingOutput = RecordingCanvas & {
  /** One encoded packet, with the geometry of the frames that it holds. */
  accept(packet: VideoPacket, geometry: RecordingGeometry): void;
  /** The recording encoder failed. The live stream goes on. */
  fail(error: Error): void;
  /** False once the recording ends; the encoder then stops. */
  active(): boolean;
};

type RecordingEncoder = {
  readonly writable: boolean;
  write(image: Buffer, ptsUs: bigint): boolean;
  close(): Promise<void>;
};

type ActiveEncoder = {
  encoder: RecordingEncoder;
  width: number;
  height: number;
};

export type GrpcRecordingEncoderOptions = {
  output: GrpcRecordingOutput;
  createEncoder(options: H264EncoderOpts): RecordingEncoder;
  fps: number;
  bitRate: number;
  /** Whether ffmpeg can count the keyframe interval in real time, from `supportsTimedKeyFrames`. */
  timedKeyFrames: boolean;
  inputFormat: H264EncoderInputFormat;
};

// @ref LLP 0018#recording-keyframes — serve-sim's recorder keyframes every 60 frames or 1 s at most
/**
 * Seconds between the recording's keyframes, as serve-sim's recorder: a seek decodes at most this
 * much, and a recording that stops without its end keeps all but about this much.
 */
export const RECORDING_KEY_FRAME_INTERVAL_S = 1;

// @ref LLP 0018#recording-encoder — a second encoder, so the live stream keeps each display's own size
/**
 * Encodes a foldable's recording on a fixed canvas, apart from the live stream.
 * A capture of another size starts a new libx264 process with the same settings
 * and canvas, so its first access unit is a keyframe with the same SPS and PPS,
 * and the recording continues in the same track.
 */
export class GrpcRecordingEncoder {
  readonly #options: GrpcRecordingEncoderOptions;
  #active: ActiveEncoder | null = null;
  readonly #retiring = new Set<Promise<void>>();
  #closed = false;
  #failed = false;

  constructor(options: GrpcRecordingEncoderOptions) {
    this.#options = options;
  }

  /** Records one captured image. A busy encoder skips it; the recording holds the last frame. */
  write(image: { image: Buffer; width: number; height: number }, ptsUs: bigint): void {
    if (this.#closed || this.#failed) return;
    if (!this.#options.output.active()) {
      void this.close();
      return;
    }
    let active = this.#active;
    if (!active || active.width !== image.width || active.height !== image.height) {
      active = this.#start(image);
      if (!active) return;
    }
    if (!active.encoder.writable) return;
    active.encoder.write(image.image, ptsUs);
  }

  #start(image: { width: number; height: number }): ActiveEncoder | null {
    const previous = this.#active;
    this.#active = null;
    // A replaced encoder's last packets hold the previous display and older timestamps.
    if (previous) this.#retire(previous.encoder);
    const geometry = recordingGeometry(image, this.#options.output);
    const entry: { current: ActiveEncoder | null } = { current: null };
    try {
      const encoder = this.#options.createEncoder({
        encoderName: "libx264",
        width: image.width,
        height: image.height,
        inputFormat: this.#options.inputFormat,
        fps: this.#options.fps,
        bitRate: this.#options.bitRate,
        keyFrameInterval: RECORDING_KEY_FRAME_INTERVAL_S,
        timedKeyFrames: this.#options.timedKeyFrames,
        canvas: { ...this.#options.output.canvas, content: geometry.contentRect },
        onFrame: (frame) => {
          if (entry.current && this.#active === entry.current) {
            this.#options.output.accept(frame, geometry);
          }
        },
        onExit: (message) => {
          if (entry.current && this.#active === entry.current) {
            this.#fail(new Error(`Recording encoder failed: ${message}`));
          }
        },
      });
      entry.current = { encoder, width: image.width, height: image.height };
      this.#active = entry.current;
      return entry.current;
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  #retire(encoder: RecordingEncoder): void {
    const task = encoder
      .close()
      .catch(() => {})
      .finally(() => this.#retiring.delete(task));
    this.#retiring.add(task);
  }

  #fail(error: Error): void {
    if (this.#failed || this.#closed) return;
    this.#failed = true;
    const active = this.#active;
    this.#active = null;
    if (active) this.#retire(active.encoder);
    this.#options.output.fail(error);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const active = this.#active;
    this.#active = null;
    if (active) this.#retire(active.encoder);
    await Promise.all([...this.#retiring]);
  }
}
