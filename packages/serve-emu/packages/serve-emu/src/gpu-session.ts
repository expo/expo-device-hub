import { createConnection, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { DisplayRotation } from "./adb.ts";
import { ControlInputQueue, SocketControlWriter } from "./control-input-queue.ts";
import { GrpcVideoPacketQueue } from "./grpc-session.ts";
import {
  GPU_RECORD,
  GPU_ROTATION_PROTOCOL,
  GpuPacketReader,
  gpuRotationCommand,
  gpuSettingsCommand,
  parseGpuDetails,
  splitGpuAccessUnit,
} from "./gpu-packet.ts";
import { H264StartupGate } from "./h264-readiness.ts";
import { compileGesture } from "./input.ts";
import { startScrcpyControl, type ScrcpyControlSession, type VideoPacket } from "./scrcpy.ts";
import type { ExperimentalGpuCaptureDiagnostics } from "./shared/api-contracts.ts";
import type { EmuSession, StartEmuSessionOptions, StreamFailure } from "./stream-session.ts";

const STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_BIT_RATE = 12_000_000;
// @ref LLP 0020#rotation — serve-emu reads the display rotation and passes it to the agent
/** How often a session reads Android's display rotation, for turns that apps start. */
const ROTATION_POLL_MS = 1_000;
const ROTATION_READ_TIMEOUT_MS = 3_000;
const activeSerials = new Set<string>();

type GpuSessionDependencies = {
  startScrcpyControl?: typeof startScrcpyControl;
  connect?: (path: string) => Socket;
  /** For tests: replaces the rotation poll timer. */
  setInterval?: (callback: () => void, intervalMs: number) => { unref?(): void };
  clearInterval?: (timer: unknown) => void;
};

/**
 * The touch target for scrcpy without video: the native display, upright for Android's display
 * rotation. The agent's native size is the panel's, so rotations 1 and 3 swap its edges.
 */
export function uprightTouchSize(
  native: { width: number; height: number },
  rotation: DisplayRotation,
): { width: number; height: number } {
  return rotation % 2 === 1
    ? { width: native.height, height: native.width }
    : { width: native.width, height: native.height };
}

/** The capture socket refused or vanished before it said hello: the emulator has no agent. */
export class GpuCaptureUnavailableError extends Error {}

/** The failure code of a session that another consumer of the agent replaced. */
export const GPU_CAPTURE_REPLACED_CODE = "gpu-capture-replaced";

// @ref LLP 0020#integration — a replaced session does not take the agent back
/**
 * Another consumer, such as a second Hub, connected to the agent, and the agent closed this
 * one. A default capture then uses gRPC, so the two do not replace each other in a loop.
 */
export class GpuCaptureReplacedError extends GpuCaptureUnavailableError {
  constructor() {
    super("Another program took over the emulator capture");
  }
}

/**
 * Video from an expo-emulator-capture agent socket; scrcpy stays the control transport.
 * The agent changes the stream size when the native display does (folding), and turns the
 * picture upright for the display rotation that this session reads and passes to it.
 */
export async function startGpuCaptureSession(
  options: StartEmuSessionOptions,
  socketPath: string,
  dependencies: GpuSessionDependencies = {},
): Promise<EmuSession> {
  if (options.mode !== "emulator-capture" || options.inputSource !== "scrcpy")
    throw new Error("Emulator capture requires scrcpy input; video comes from the capture socket");
  if (!socketPath.startsWith("/")) throw new Error("Emulator capture socket path must be absolute");
  if (activeSerials.has(options.serial))
    throw new Error("Emulator capture already has a session for this device");
  const socket = (dependencies.connect ?? createConnection)(socketPath);
  activeSerials.add(options.serial);
  const queue = new GrpcVideoPacketQueue(16 * 1024 * 1024);
  const startup = new H264StartupGate();
  const listeners = new Set<(failure: StreamFailure) => void>();
  const waiters: ((packet: VideoPacket | null) => void)[] = [];
  const abort = new AbortController();
  const signal = options.signal ?? abort.signal;
  // Ends rotation reads when the session closes.
  const lifetime = new AbortController();
  let control: ScrcpyControlSession | null = null;
  let controls: ControlInputQueue | null = null;
  let closed = false,
    failed: StreamFailure | null = null;
  let closeTask: Promise<void> | null = null;
  let hello = false,
    configured = false,
    packets = 0,
    bytes = 0,
    keyRequests = 0,
    lastKeyRequest = 0,
    resizes = 0,
    rotations = 0;
  let lastPts = -1n;
  let sps: Buffer | null = null,
    pps: Buffer | null = null,
    config: Buffer | null = null;
  let framePath: ExperimentalGpuCaptureDiagnostics["framePath"] = null;
  let hardwareEncoder: boolean | null = null;
  let encoderName: string | null = null;
  const meta = { deviceName: "Emulator capture", codecId: "h264", width: 0, height: 0 };
  const nativeSize = { width: 0, height: 0 };
  let streamFps = options.maxFps || 60;
  const maxSize = options.maxSize ?? 0;
  // Android's display rotation as last read; the agent's picture follows it.
  let displayRotation: DisplayRotation = 0;
  // The rotation of the picture that clients show: from the agent's last configured record.
  let pictureRotation: DisplayRotation | null = null;
  let rotationSupported = false;
  let rotationRead: Promise<void> | null = null;
  let readAgain = false;
  let rotationTimer: unknown = null;
  const setTimer = dependencies.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const clearTimer =
    dependencies.clearInterval ??
    ((timer: unknown) => clearInterval(timer as ReturnType<typeof setInterval>));

  let receivedBytes = 0;
  const fail = (error: unknown) => {
    if (failed || closed) return;
    const cause = error instanceof Error ? error : new Error(String(error));
    failed = {
      message: cause.message,
      code:
        cause instanceof GpuCaptureReplacedError ? GPU_CAPTURE_REPLACED_CODE : "gpu-capture-error",
    };
    // Nothing answered on the socket: no agent serves it. A peer that sent bytes is broken.
    startup.fail(
      receivedBytes === 0 ? new GpuCaptureUnavailableError(cause.message, { cause }) : cause,
    );
    socket.destroy();
    lifetime.abort();
    for (const listener of listeners) listener(failed);
    while (waiters.length) waiters.shift()!(null);
  };
  const write = (command: Buffer) => {
    if (closed || failed || socket.destroyed) return;
    socket.write(command, (error) => {
      if (error) fail(error);
    });
  };
  const requestKey = () => {
    if (closed || failed || socket.destroyed) return;
    const now = Date.now();
    if (now - lastKeyRequest < 200) return;
    lastKeyRequest = now;
    keyRequests++;
    write(Buffer.from("K"));
  };
  const readRotation = async (): Promise<DisplayRotation | null> => {
    if (!options.readDisplayRotation) return null;
    try {
      return await options.readDisplayRotation(
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(ROTATION_READ_TIMEOUT_MS)]),
      );
    } catch {
      return null; // Keep the last rotation; the next poll tries again.
    }
  };
  /**
   * Reads the display rotation and passes a change to the agent; one read at a time. A call
   * during a read, such as after `POST /api/orientation`, reads once more when it ends.
   */
  const refreshRotation = () => {
    if (!rotationSupported || closed || failed) return;
    if (rotationRead) {
      readAgain = true;
      return;
    }
    rotationRead = (async () => {
      try {
        const next = await readRotation();
        if (next === null || next === displayRotation || closed || failed) return;
        displayRotation = next;
        rotations++;
        write(gpuRotationCommand(next));
      } finally {
        rotationRead = null;
        if (readAgain) {
          readAgain = false;
          refreshRotation();
        }
      }
    })();
  };
  /** After hello: the rotation first, so the agent's first session is already upright. */
  const negotiate = async () => {
    if (rotationSupported) {
      const rotation = await readRotation();
      if (rotation !== null) {
        displayRotation = rotation;
        if (rotation !== 0) write(gpuRotationCommand(rotation));
      }
    }
    write(gpuSettingsCommand(maxSize, streamFps, options.bitRate ?? DEFAULT_BIT_RATE));
  };
  // Touches follow the picture that the client shows. The display can turn about a second
  // before the agent's turned picture arrives.
  const touchSize = () => uprightTouchSize(nativeSize, pictureRotation ?? displayRotation);
  const push = (packet: VideoPacket) => {
    const result = queue.push(packet);
    if (result.needsKeyFrame) requestKey();
    if (packet.type === "frame" && result.queued) startup.observe(packet);
    while (waiters.length) {
      const next = queue.shift();
      if (!next) break;
      waiters.shift()!(next);
    }
  };
  const reader = new GpuPacketReader((record) => {
    if (record.flags === GPU_RECORD.hello) {
      if (hello) throw new Error("Unexpected second GPU stream handshake");
      hello = true;
      const details = parseGpuDetails(record.data);
      rotationSupported =
        !!options.readDisplayRotation &&
        typeof details.protocol === "number" &&
        details.protocol >= GPU_ROTATION_PROTOCOL;
      nativeSize.width = record.width;
      nativeSize.height = record.height;
      void negotiate().catch(fail);
      return;
    }
    if (!hello) throw new Error("GPU stream did not start with a handshake");
    if (record.flags === GPU_RECORD.replaced) throw new GpuCaptureReplacedError();
    if (record.flags === GPU_RECORD.resized) {
      // The native display changed (fold or unfold); touches target it directly.
      nativeSize.width = record.width;
      nativeSize.height = record.height;
      resizes++;
      return;
    }
    if (record.flags === GPU_RECORD.configured) {
      const details = parseGpuDetails(record.data);
      framePath =
        details.framePath === "gpu" || details.framePath === "cpu" ? details.framePath : null;
      hardwareEncoder =
        typeof details.hardwareEncoder === "boolean" ? details.hardwareEncoder : null;
      encoderName = typeof details.encoder === "string" ? details.encoder : null;
      pictureRotation =
        details.rotation === 0 ||
        details.rotation === 1 ||
        details.rotation === 2 ||
        details.rotation === 3
          ? details.rotation
          : null;
      const announce = configured && (record.width !== meta.width || record.height !== meta.height);
      meta.width = record.width;
      meta.height = record.height;
      streamFps = record.fps;
      configured = true;
      sps = pps = config = null;
      // Clients resync from the next keyframe at the new size, as after a rotation.
      if (announce)
        push({ type: "session", width: meta.width, height: meta.height, clientResized: false });
      return;
    }
    if (!configured) throw new Error("GPU stream arrived before settings acknowledgement");
    if (record.width !== meta.width || record.height !== meta.height || record.fps !== streamFps)
      throw new Error("GPU stream does not match the configured settings");
    if (record.pts <= lastPts) throw new Error("GPU stream timestamp did not increase");
    lastPts = record.pts;
    packets++;
    bytes += record.data.length;
    const unit = splitGpuAccessUnit(record.data);
    sps = unit.sps ?? sps;
    pps = unit.pps ?? pps;
    if (sps && pps) {
      const next = Buffer.concat([sps, pps]);
      if (!config?.equals(next)) {
        config = next;
        push({ type: "frame", data: next, pts: record.pts, isConfig: true, isKey: false });
      }
    }
    if (unit.data.length)
      push({ type: "frame", data: unit.data, pts: record.pts, isConfig: false, isKey: unit.isIdr });
  });
  socket.on("data", (chunk) => {
    receivedBytes += chunk.length;
    try {
      reader.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    } catch (error) {
      fail(error);
    }
  });
  socket.on("error", fail);
  socket.on("end", () => {
    try {
      reader.end();
    } catch (error) {
      fail(error);
    }
  });
  socket.on("close", () => fail(new Error("Emulator capture connection closed")));
  const close = (): Promise<void> => {
    if (closeTask) return closeTask;
    closed = true;
    activeSerials.delete(options.serial);
    if (rotationTimer !== null) clearTimer(rotationTimer);
    rotationTimer = null;
    lifetime.abort();
    socket.destroy();
    controls?.close(new Error("Emulator capture session closed"));
    queue.clear();
    while (waiters.length) waiters.shift()!(null);
    listeners.clear();
    closeTask = Promise.resolve(control?.close());
    return closeTask;
  };
  try {
    await startup.wait(signal, STARTUP_TIMEOUT_MS);
    control = await (dependencies.startScrcpyControl ?? startScrcpyControl)(options);
    if (signal.aborted || failed) throw new Error("Emulator capture startup interrupted");
    const writer = new SocketControlWriter(control.controlSocket);
    control.controlSocket.on("error", fail);
    control.proc.on("exit", () => fail(new Error("Emulator capture control process exited")));
    controls = new ControlInputQueue({
      dispatcher: {
        async dispatchGesture(gesture, _screen, inputSignal) {
          // With scrcpy video disabled, touches target the native display, not the scaled
          // stream (as in grpc-session.ts), in the display's current rotation.
          for (const step of compileGesture(gesture, touchSize()).steps) {
            if (step.delayMs > 0) await delay(step.delayMs, undefined, { signal: inputSignal });
            await writer.write(step.packet, inputSignal);
          }
        },
        async resetVideo(inputSignal) {
          inputSignal.throwIfAborted();
          requestKey();
        },
        close(reason) {
          writer.close(reason);
        },
      },
    });
    if (rotationSupported) {
      const timer = setTimer(refreshRotation, ROTATION_POLL_MS);
      timer.unref?.();
      rotationTimer = timer;
    }
    console.warn(
      `[emulator capture] ${options.serial}: ${framePath ?? "unknown"} frames, ${meta.width}x${meta.height}@${streamFps} (native ${nativeSize.width}x${nativeSize.height}, rotation ${displayRotation}); scrcpy controls only`,
    );
    return {
      mode: "emulator-capture",
      inputSource: "scrcpy",
      serial: options.serial,
      meta,
      controls,
      diagnostics: () => ({
        experimentalGpuCapture: {
          backend: "expo-emulator-capture",
          framePath,
          hardwareEncoder,
          encoderName,
          packets,
          bytes,
          requestedKeyFrames: keyRequests,
          queuedBytes: queue.byteLength,
          fps: streamFps,
          nativeSize: { ...nativeSize },
          streamSize: { width: meta.width, height: meta.height },
          maxSize,
          resizes,
          rotation: rotationSupported ? displayRotation : null,
          rotations,
          touchSize: touchSize(),
        },
      }),
      displayChanged: refreshRotation,
      readFrame() {
        if (closed || failed) return Promise.resolve(null);
        const packet = queue.shift();
        return packet ? Promise.resolve(packet) : new Promise((resolve) => waiters.push(resolve));
      },
      onFatal(listener) {
        listeners.add(listener);
        if (failed) listener(failed);
        return () => {
          listeners.delete(listener);
        };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
