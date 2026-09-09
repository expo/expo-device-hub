import { ControlInputQueue } from "./control-input-queue.ts";
import { isEmulatorSerial } from "./device-capabilities.ts";
import { startGrpcSession } from "./grpc-session.ts";
import { H264StartupGate } from "./h264-readiness.ts";
import {
  startScrcpy,
  type ScrcpySession,
  type StartOpts,
  type VideoPacket,
} from "./scrcpy.ts";
import type {
  GrpcCaptureDiagnostics,
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
  /** Present only on the scrcpy adapter during the server migration. */
  readonly rawScrcpy?: ScrcpySession;
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
  /** Exact input source. scrcpy capture always requires scrcpy input. */
  inputSource: InputSource;
};

export async function startEmuSession(
  options: StartEmuSessionOptions,
): Promise<EmuSession> {
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
  return prepareDecodableScrcpySession(
    await startScrcpy(options),
    options.signal,
  );
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
      const packet = await Promise.race([
        raw.readFrame(),
        readiness.then(() => STARTUP_READY),
      ]);
      if (typeof packet === "symbol") break;
      if (packet === null) {
        throw new Error(
          "scrcpy stream ended before producing decodable H.264 output",
        );
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
    const { reason, ...detail } = procExitDetail(code, signal);
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
