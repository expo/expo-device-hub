import type { DisplayRotation } from "./adb.ts";
import { ControlInputQueue } from "./control-input-queue.ts";
import { isEmulatorSerial } from "./device-capabilities.ts";
import { startGpuCaptureSession } from "./gpu-session.ts";
import type { GrpcRecordingOutput } from "./grpc-recording-encoder.ts";
import { startGrpcSession } from "./grpc-session.ts";
import { H264StartupGate } from "./h264-readiness.ts";
import { startScrcpy, type ScrcpySession, type StartOpts, type VideoPacket } from "./scrcpy.ts";
import type {
  ExperimentalGpuCaptureDiagnostics,
  GrpcCaptureDiagnostics,
  GrpcEncoder,
  GrpcImageMode,
  InputSource,
  StreamMode,
} from "./shared/api-contracts.ts";
import { isAbnormalExit, procExitDetail } from "./session-status.ts";

const SCRCPY_READINESS_TIMEOUT_MS = 10_000;
const MAX_SCRCPY_STARTUP_PACKETS = 256;
const MAX_SCRCPY_STARTUP_BYTES = 64 * 1024 * 1024;
const STARTUP_READY: unique symbol = Symbol("scrcpy-startup-ready");
const NEVER_ABORTED = new AbortController().signal;

export type {
  ExperimentalGpuCaptureDiagnostics,
  GrpcCaptureDiagnostics,
  RollingTimingSummary,
} from "./shared/api-contracts.ts";

export type StreamFailure = {
  message: string;
  code?: string;
  meta?: Record<string, string | number>;
};

export type StreamMeta = ScrcpySession["meta"];

export type EmuSessionDiagnostics = {
  /** Present only when an expo-emulator-capture agent supplies the video. */
  experimentalGpuCapture?: ExperimentalGpuCaptureDiagnostics;
  /** Present only for the grpc-screenshot capture implementation. */
  grpcCapture?: GrpcCaptureDiagnostics;
};

/**
 * A stream source hides capture, encoding, input transport, keyframe recovery,
 * and cleanup behind one interface used by both the Bun server and middleware.
 */
export type EmuSession = {
  readonly mode: StreamMode;
  readonly inputSource: InputSource;
  readonly serial: string;
  readonly meta: StreamMeta;
  readonly controls: ControlInputQueue;
  /** Optional source-specific live diagnostics, sampled without mutating capture. */
  readonly diagnostics?: () => EmuSessionDiagnostics;
  /**
   * The device's display may have changed (for example, the router rotated it). A source that
   * follows the display reads it again now instead of at its next poll.
   */
  displayChanged?(): void;
  /** Present only on the scrcpy adapter during the server migration. */
  readonly rawScrcpy?: ScrcpySession;
  /**
   * True when the session encodes the screen recording itself, from `recording`. Its
   * `readFrame` packets are then for viewers only.
   */
  readonly feedsRecording?: boolean;
  readFrame(): Promise<VideoPacket | null>;
  /** Emits only the first terminal failure and immediately replays it to late subscribers. */
  onFatal(listener: (failure: StreamFailure) => void): () => void;
  close(): Promise<void>;
};

export type StartEmuSessionOptions = StartOpts & {
  /** Exact source selection. This factory never silently falls back. */
  mode: StreamMode;
  /** Exact emulator screenshot image mode. Capture never silently falls back. */
  grpcImageMode: GrpcImageMode;
  /** Host H.264 encoder used only for gRPC capture; defaults to software. */
  encoder?: GrpcEncoder;
  /** Exact input source. scrcpy and emulator capture always require scrcpy input. */
  inputSource: InputSource;
  /**
   * For `emulator-capture`: the expo-emulator-capture agent socket of this emulator.
   * Only the middleware sets it; see `emulatorCaptureSocketFor` there.
   */
  emulatorCaptureSocket?: string;
  /** For `emulator-capture`: reads Android's display rotation, so the agent can turn frames. */
  readDisplayRotation?: (signal: AbortSignal) => Promise<DisplayRotation>;
  /**
   * A foldable's recording on a fixed canvas. Only gRPC capture encodes it; scrcpy capture
   * ignores it, and the recording then takes the viewers' packets.
   */
  recording?: GrpcRecordingOutput;
};

export async function startEmuSession(options: StartEmuSessionOptions): Promise<EmuSession> {
  // @ref LLP 0020#integration — only the middleware passes the socket; the agent serves one consumer
  if (options.mode === "emulator-capture") {
    if (!options.emulatorCaptureSocket) {
      throw new Error(`emulator capture has no agent socket for ${options.serial}`);
    }
    return startGpuCaptureSession(options, options.emulatorCaptureSocket);
  }
  if (options.mode === "grpc-screenshot") {
    if (!isEmulatorSerial(options.serial)) {
      throw new Error(
        `grpc-screenshot requires an Android Emulator serial; received ${options.serial}`,
      );
    }
    return startGrpcSession(options);
  }
  if (options.mode !== "scrcpy") {
    const exhaustive: never = options.mode;
    throw new Error(`unsupported stream mode ${String(exhaustive)}`);
  }
  if (options.inputSource !== "scrcpy") {
    throw new Error("scrcpy streaming requires scrcpy input");
  }
  const { encoder: _encoder, recording: _recording, ...scrcpyOptions } = options;
  return prepareDecodableScrcpySession(await startScrcpy(scrcpyOptions), options.signal);
}

/**
 * Buffer scrcpy output until SPS, PPS, and an initial keyframe are available.
 * This keeps a replacement private until a newly joined browser can decode it.
 */
export async function prepareDecodableScrcpySession(
  raw: ScrcpySession,
  signal: AbortSignal = NEVER_ABORTED,
  timeoutMs = SCRCPY_READINESS_TIMEOUT_MS,
): Promise<EmuSession> {
  const gate = new H264StartupGate();
  const buffered: VideoPacket[] = [];
  let bufferedBytes = 0;
  const readiness = gate.wait(signal, timeoutMs);

  try {
    while (!gate.ready) {
      const packet = await Promise.race([raw.readFrame(), readiness.then(() => STARTUP_READY)]);
      if (typeof packet === "symbol") break;
      if (packet === null) {
        throw new Error("scrcpy stream ended before producing decodable H.264 output");
      }

      bufferedBytes += packet.type === "frame" ? packet.data.length : 16;
      if (
        buffered.length >= MAX_SCRCPY_STARTUP_PACKETS ||
        bufferedBytes > MAX_SCRCPY_STARTUP_BYTES
      ) {
        throw new Error("scrcpy startup output exceeded the readiness buffer");
      }
      buffered.push(packet);
      if (packet.type === "frame") gate.observe(packet);
    }
    await readiness;
    return adaptScrcpySession(raw, undefined, buffered);
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    gate.fail(cause);
    await readiness.catch(() => {});
    try {
      await raw.close();
    } catch (cleanupError) {
      throw new AggregateError([cause, cleanupError], cause.message, {
        cause,
      });
    }
    throw cause;
  }
}

export function adaptScrcpySession(
  raw: ScrcpySession,
  controls = new ControlInputQueue({ socket: raw.controlSocket }),
  initialPackets: readonly VideoPacket[] = [],
): EmuSession {
  const listeners = new Set<(failure: StreamFailure) => void>();
  const buffered = [...initialPackets];
  let closed = false;
  let closeTask: Promise<void> | null = null;
  let fatalFailure: StreamFailure | null = null;

  const emitFatal = (failure: StreamFailure) => {
    if (closed || fatalFailure) return;
    fatalFailure = failure;
    for (const listener of listeners) listener(failure);
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (!isAbnormalExit(code, signal)) return;
    const { reason, ...detail } = procExitDetail(code, signal, raw.stderrTail?.());
    emitFatal({ message: reason, ...detail });
  };
  const onControlError = (error: Error) => {
    emitFatal({
      message: `scrcpy control socket error: ${error.message}`,
      code: "control-socket-error",
    });
  };
  raw.proc.on("exit", onExit);
  raw.controlSocket.on("error", onControlError);

  return {
    mode: "scrcpy",
    inputSource: "scrcpy",
    serial: raw.serial,
    meta: raw.meta,
    controls,
    rawScrcpy: raw,
    readFrame() {
      const packet = buffered.shift();
      return packet ? Promise.resolve(packet) : raw.readFrame();
    },
    onFatal(listener) {
      listeners.add(listener);
      if (fatalFailure) listener(fatalFailure);
      return () => listeners.delete(listener);
    },
    close() {
      if (closeTask) return closeTask;
      closed = true;
      raw.proc.off("exit", onExit);
      raw.controlSocket.off("error", onControlError);
      controls.close(new Error("stream session closed"));
      buffered.length = 0;
      listeners.clear();
      closeTask = Promise.resolve(raw.close());
      return closeTask;
    },
  };
}
