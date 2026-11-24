import { setTimeout as sleep } from "node:timers/promises";
import {
  type AudioFormatRequest,
  type AudioInjectionStream,
  EmulatorGrpcClient,
  ensureEmulatorGrpcEndpoint,
} from "./emulator-grpc.ts";
import { MIC_BYTES_PER_SECOND, MIC_FORMAT, type MicPcm } from "./mic-audio.ts";
import { isMicRecording, readMicRecordingClients } from "./mic-recording.ts";

/**
 * Microphone injection into one Android emulator.
 *
 * The emulator's `injectAudio` call is fragile, so the injector follows the stream rules of
 * LLP 0026 (Android rules 2 to 5):
 *
 * - It opens the call only while an app records, and only after the recording has been active
 *   for {@link STREAM_OPEN_DELAY_MS}. A call that opens earlier can crash the emulator.
 * - It keeps one call open for the life of the emulator, and sends silence when there is no
 *   source. A call that ends while nothing records breaks later calls until the emulator
 *   restarts. So the injector never ends the call on its own, except in {@link dispose}.
 * - It writes only while an app records. Packets that nothing reads corrupt the next recording.
 * - It uses `MODE_REAL_TIME` and paces the audio itself, at most {@link MAX_AHEAD_MS} ahead.
 *
 * The injector does nothing until the first {@link MicInjector.play}, so an emulator whose
 * microphone is never used never gets a call.
 */

/** @ref LLP 0026#android — a call opened sooner after recording starts crashed the emulator. */
export const STREAM_OPEN_DELAY_MS = 2_000;
/** How often the injector reads the recording state while it waits to open the call. */
export const RECORDING_POLL_MS = 250;
/** Audio in one packet. */
export const PACKET_MS = 20;
/** @ref LLP 0026#android — realtime packets that run further ahead overwrite each other. */
export const MAX_AHEAD_MS = 100;

const PACKET_BYTES = (MIC_BYTES_PER_SECOND * PACKET_MS) / 1_000;
const SILENCE = Buffer.alloc(PACKET_BYTES);
const END_TIMEOUT_MS = 1_000;

export type MicSourceStatus =
  | { kind: "silence" }
  | { kind: "pcm"; label: string; loop: boolean; positionMs: number; durationMs: number };

/**
 * - `idle`: no source was ever played, so no call is needed.
 * - `waiting`: waiting for an app to record before the call opens.
 * - `starting`: an app records; the call opens when the delay ends.
 * - `streaming`: the call is open and audio flows.
 */
export type MicStreamState = "idle" | "waiting" | "starting" | "streaming";

export type MicInjectorStatus = {
  serial: string;
  stream: MicStreamState;
  source: MicSourceStatus;
  /** The last error of the call or of recording detection, or null. */
  lastError: string | null;
};

export type MicInjectorDependencies = {
  /** True while an app records from the microphone. */
  isRecording?(signal: AbortSignal): Promise<boolean>;
  /** Opens an `injectAudio` call. */
  openStream?(format: AudioFormatRequest, signal: AbortSignal): Promise<AudioInjectionStream>;
  /** Called when a call fails, so the next open can find the emulator again. */
  resetStream?(): void;
  now?(): number;
  wait?(ms: number, signal: AbortSignal): Promise<void>;
  log?(message: string): void;
};

type Source = {
  pcm: MicPcm;
  label: string;
  loop: boolean;
  /** Byte offset of the next packet. */
  offset: number;
};

export class MicInjector {
  readonly serial: string;
  readonly #isRecording: (signal: AbortSignal) => Promise<boolean>;
  readonly #openStream: (
    format: AudioFormatRequest,
    signal: AbortSignal,
  ) => Promise<AudioInjectionStream>;
  readonly #resetStream: () => void;
  readonly #now: () => number;
  readonly #wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #log: (message: string) => void;
  /** Stops the loop. */
  readonly #abort = new AbortController();
  /** Cancels the call. Separate, so that dispose can end the call cleanly after the loop. */
  readonly #streamAbort = new AbortController();
  #source: Source | null = null;
  #state: MicStreamState = "idle";
  #lastError: string | null = null;
  #stream: AudioInjectionStream | null = null;
  #run: Promise<void> | null = null;

  constructor(serial: string, dependencies: MicInjectorDependencies = {}) {
    this.serial = serial;
    this.#isRecording =
      dependencies.isRecording ??
      (async (signal) => isMicRecording(await readMicRecordingClients(serial, { signal })));
    const grpc = dependencies.openStream ? null : defaultGrpcStreams(serial);
    this.#openStream = dependencies.openStream ?? grpc!.open;
    this.#resetStream = dependencies.resetStream ?? grpc?.reset ?? (() => {});
    this.#now = dependencies.now ?? (() => performance.now());
    this.#wait = dependencies.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }));
    this.#log = dependencies.log ?? ((message) => console.warn(`serve-emu mic: ${message}`));
  }

  /**
   * Plays mono 16-bit PCM at {@link MIC_FORMAT}'s rate, from the start. It replaces the current
   * source. Without `loop`, the microphone goes back to silence at the end. The audio advances
   * only while the call is open, so audio played before an app records starts when the call
   * opens.
   */
  play(pcm: MicPcm, options: { label: string; loop?: boolean }): MicInjectorStatus {
    if (this.#abort.signal.aborted) throw new Error("microphone injector is disposed");
    if (pcm.length === 0) throw new Error("audio has no samples");
    // Whole 16-bit frames only, so a packet never starts in the middle of a sample.
    const whole = pcm.subarray(0, pcm.length - (pcm.length % 2));
    this.#source = { pcm: whole, label: options.label, loop: options.loop ?? false, offset: 0 };
    this.#start();
    return this.status();
  }

  /** Sends silence. An open call stays open (LLP 0026, Android rule 3). */
  stop(): MicInjectorStatus {
    this.#source = null;
    return this.status();
  }

  status(): MicInjectorStatus {
    const source = this.#source;
    return {
      serial: this.serial,
      stream: this.#state,
      source: source
        ? {
            kind: "pcm",
            label: source.label,
            loop: source.loop,
            positionMs: Math.round((source.offset / MIC_BYTES_PER_SECOND) * 1_000),
            durationMs: Math.round((source.pcm.length / MIC_BYTES_PER_SECOND) * 1_000),
          }
        : { kind: "silence" },
      lastError: this.#lastError,
    };
  }

  /**
   * Stops the injector and ends its call. Call it only when the emulator or serve-emu stops:
   * if the emulator keeps running and nothing records, later calls can record silence until
   * the emulator restarts.
   */
  async dispose(): Promise<void> {
    if (this.#abort.signal.aborted) return;
    this.#abort.abort(new Error("microphone injector disposed"));
    await this.#run?.catch(() => {});
    const stream = this.#stream;
    this.#stream = null;
    if (stream) {
      // End the call cleanly when possible, then cancel it.
      const ended = stream.end().catch(() => {});
      await Promise.race([ended, sleep(END_TIMEOUT_MS)]);
    }
    this.#streamAbort.abort(new Error("microphone injector disposed"));
    this.#resetStream();
    this.#state = "idle";
  }

  #start(): void {
    if (this.#run) return;
    this.#state = "waiting";
    this.#run = this.#loop().finally(() => {
      this.#run = null;
    });
  }

  async #loop(): Promise<void> {
    const signal = this.#abort.signal;
    while (!signal.aborted) {
      try {
        this.#state = "waiting";
        await this.#waitForRecording(signal);
        await this.#sendAudio(signal);
      } catch (error) {
        if (signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        // A broken emulator fails every attempt. Log each new error once.
        if (message !== this.#lastError) this.#log(`${this.serial}: ${message}`);
        this.#lastError = message;
        this.#state = "waiting";
        this.#stream = null;
        this.#resetStream();
        // Wait a little before the next attempt, so a broken emulator does not spin.
        await this.#wait(RECORDING_POLL_MS, signal).catch(() => {});
      }
    }
  }

  /** Resolves when an app has recorded for {@link STREAM_OPEN_DELAY_MS} without a break. */
  async #waitForRecording(signal: AbortSignal): Promise<void> {
    let recordingSince: number | null = null;
    while (true) {
      const recording = await this.#isRecording(signal);
      if (!recording) {
        recordingSince = null;
        this.#state = "waiting";
      } else {
        recordingSince ??= this.#now();
        this.#state = "starting";
        if (this.#now() - recordingSince >= STREAM_OPEN_DELAY_MS) return;
      }
      await this.#wait(RECORDING_POLL_MS, signal);
    }
  }

  /** Opens the call and sends paced packets until the call fails or the injector stops. */
  async #sendAudio(signal: AbortSignal): Promise<void> {
    const stream = await this.#openStream(MIC_FORMAT, this.#streamAbort.signal);
    this.#stream = stream;
    if (signal.aborted) return;
    this.#state = "streaming";
    this.#lastError = null;
    let failure: unknown = null;
    stream.done.catch((error: unknown) => {
      failure = error;
    });
    // The call opened because an app records. Keep the recording state current while it is open.
    let recording = true;
    const watch = (async () => {
      while (!signal.aborted && !failure) {
        await this.#wait(RECORDING_POLL_MS, signal);
        try {
          recording = await this.#isRecording(signal);
        } catch {
          // Keep the last known state. A real failure also fails the call.
        }
      }
    })().catch(() => {});
    try {
      await this.#pace(
        stream,
        signal,
        () => recording,
        () => failure,
      );
    } finally {
      await watch;
    }
  }

  async #pace(
    stream: AudioInjectionStream,
    signal: AbortSignal,
    isRecording: () => boolean,
    failure: () => unknown,
  ): Promise<void> {
    let startedAt = this.#now();
    let sentMs = 0;
    let paused = false;
    while (!signal.aborted) {
      if (failure()) throw failure();
      if (!isRecording()) {
        // @ref LLP 0026#android — realtime packets that nothing reads corrupt the next recording.
        paused = true;
        await this.#wait(RECORDING_POLL_MS, signal);
        continue;
      }
      if (paused) {
        paused = false;
        startedAt = this.#now();
        sentMs = 0;
      }
      if (sentMs - (this.#now() - startedAt) < -MAX_AHEAD_MS) {
        // The event loop stalled. A burst to catch up would overwrite itself in realtime
        // mode, so restart the clock and accept the delay.
        startedAt = this.#now() - sentMs;
      }
      await stream.write(this.#nextPacket());
      sentMs += PACKET_MS;
      // Sleep only as long as needed to stay at most MAX_AHEAD_MS ahead of real time.
      const aheadMs = sentMs - (this.#now() - startedAt);
      if (aheadMs > MAX_AHEAD_MS) await this.#wait(aheadMs - MAX_AHEAD_MS, signal);
    }
  }

  #nextPacket(): Buffer {
    const source = this.#source;
    if (!source) return SILENCE;
    const packet = Buffer.alloc(PACKET_BYTES);
    let filled = 0;
    while (filled < PACKET_BYTES) {
      if (source.offset >= source.pcm.length) {
        if (!source.loop) {
          // The rest of the packet stays silent.
          if (this.#source === source) this.#source = null;
          break;
        }
        source.offset = 0;
      }
      const copied = source.pcm.copy(
        packet,
        filled,
        source.offset,
        source.offset + PACKET_BYTES - filled,
      );
      filled += copied;
      source.offset += copied;
    }
    return packet;
  }
}

/** Opens calls on one gRPC client, and drops the client after a failure. */
function defaultGrpcStreams(serial: string): {
  open(format: AudioFormatRequest, signal: AbortSignal): Promise<AudioInjectionStream>;
  reset(): void;
} {
  let client: EmulatorGrpcClient | null = null;
  return {
    async open(format, signal) {
      client ??= new EmulatorGrpcClient(await ensureEmulatorGrpcEndpoint(serial, signal));
      return client.injectAudio(format, signal);
    },
    reset() {
      client?.close();
      client = null;
    },
  };
}

/** One injector for each emulator serial, kept for the life of serve-emu. */
export class MicInjectors {
  readonly #injectors = new Map<string, MicInjector>();
  readonly #create: (serial: string) => MicInjector;

  constructor(create: (serial: string) => MicInjector = (serial) => new MicInjector(serial)) {
    this.#create = create;
  }

  get(serial: string): MicInjector {
    let injector = this.#injectors.get(serial);
    if (!injector) {
      injector = this.#create(serial);
      this.#injectors.set(serial, injector);
    }
    return injector;
  }

  /** The status of a serial's injector, without creating one. */
  status(serial: string): MicInjectorStatus {
    return (
      this.#injectors.get(serial)?.status() ?? {
        serial,
        stream: "idle",
        source: { kind: "silence" },
        lastError: null,
      }
    );
  }

  async disposeAll(): Promise<void> {
    const injectors = [...this.#injectors.values()];
    this.#injectors.clear();
    await Promise.all(injectors.map((injector) => injector.dispose()));
  }
}
