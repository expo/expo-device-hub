import { createConnection, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { ControlInputQueue, SocketControlWriter } from "./control-input-queue.ts";
import { GrpcVideoPacketQueue } from "./grpc-session.ts";
import {
  GPU_RECORD,
  GpuPacketReader,
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
const activeSerials = new Set<string>();

type GpuSessionDependencies = {
  startScrcpyControl?: typeof startScrcpyControl;
  connect?: (path: string) => Socket;
};

/** The capture socket refused or vanished before it said hello: the emulator has no agent. */
export class GpuCaptureUnavailableError extends Error {}

/**
 * Video from an expo-emulator-capture agent socket; scrcpy stays the control transport.
 * The agent changes the stream size when the native display does (folding).
 */
export async function startGpuCaptureSession(
  options: StartEmuSessionOptions,
  socketPath: string,
  dependencies: GpuSessionDependencies = {},
): Promise<EmuSession> {
  if (options.mode !== "scrcpy" || options.inputSource !== "scrcpy")
    throw new Error(
      "GPU capture requires scrcpy control mode; video comes from the capture socket",
    );
  if (!socketPath.startsWith("/")) throw new Error("GPU capture socket path must be absolute");
  if (activeSerials.has(options.serial))
    throw new Error("GPU capture already has a session for this device");
  const socket = (dependencies.connect ?? createConnection)(socketPath);
  activeSerials.add(options.serial);
  const queue = new GrpcVideoPacketQueue(16 * 1024 * 1024);
  const startup = new H264StartupGate();
  const listeners = new Set<(failure: StreamFailure) => void>();
  const waiters: ((packet: VideoPacket | null) => void)[] = [];
  const abort = new AbortController();
  const signal = options.signal ?? abort.signal;
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
    resizes = 0;
  let lastPts = -1n;
  let sps: Buffer | null = null,
    pps: Buffer | null = null,
    config: Buffer | null = null;
  let framePath: ExperimentalGpuCaptureDiagnostics["framePath"] = null;
  let hardwareEncoder: boolean | null = null;
  let encoderName: string | null = null;
  const meta = { deviceName: "GPU capture", codecId: "h264", width: 0, height: 0 };
  const nativeSize = { width: 0, height: 0 };
  let streamFps = options.maxFps || 60;
  const maxSize = options.maxSize ?? 0;

  let receivedBytes = 0;
  const fail = (error: unknown) => {
    if (failed || closed) return;
    const cause = error instanceof Error ? error : new Error(String(error));
    failed = { message: cause.message, code: "gpu-capture-error" };
    // Nothing answered on the socket: no agent serves it. A peer that sent bytes is broken.
    startup.fail(
      receivedBytes === 0 ? new GpuCaptureUnavailableError(cause.message, { cause }) : cause,
    );
    socket.destroy();
    for (const listener of listeners) listener(failed);
    while (waiters.length) waiters.shift()!(null);
  };
  const requestKey = () => {
    if (closed || failed || socket.destroyed) return;
    const now = Date.now();
    if (now - lastKeyRequest < 200) return;
    lastKeyRequest = now;
    keyRequests++;
    socket.write("K", (error) => {
      if (error) fail(error);
    });
  };
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
      parseGpuDetails(record.data);
      nativeSize.width = record.width;
      nativeSize.height = record.height;
      socket.write(
        gpuSettingsCommand(maxSize, streamFps, options.bitRate ?? DEFAULT_BIT_RATE),
        (error) => {
          if (error) fail(error);
        },
      );
      return;
    }
    if (!hello) throw new Error("GPU stream did not start with a handshake");
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
  socket.on("close", () => fail(new Error("GPU capture connection closed")));
  const close = (): Promise<void> => {
    if (closeTask) return closeTask;
    closed = true;
    activeSerials.delete(options.serial);
    socket.destroy();
    controls?.close(new Error("GPU capture session closed"));
    queue.clear();
    while (waiters.length) waiters.shift()!(null);
    listeners.clear();
    closeTask = Promise.resolve(control?.close());
    return closeTask;
  };
  try {
    await startup.wait(signal, STARTUP_TIMEOUT_MS);
    control = await (dependencies.startScrcpyControl ?? startScrcpyControl)(options);
    if (signal.aborted || failed) throw new Error("GPU capture startup interrupted");
    const writer = new SocketControlWriter(control.controlSocket);
    control.controlSocket.on("error", fail);
    control.proc.on("exit", () => fail(new Error("GPU capture control process exited")));
    controls = new ControlInputQueue({
      dispatcher: {
        async dispatchGesture(gesture, _screen, inputSignal) {
          // With scrcpy video disabled, touches target the native display, not
          // the scaled stream (as in grpc-session.ts).
          for (const step of compileGesture(gesture, nativeSize).steps) {
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
    console.warn(
      `[GPU capture] ${options.serial}: ${framePath ?? "unknown"} frames → VideoToolbox, ${meta.width}x${meta.height}@${streamFps} (native ${nativeSize.width}x${nativeSize.height}); scrcpy controls only`,
    );
    return {
      // Keep the public stream mode; /health.captureBackend names the capture source.
      mode: options.mode,
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
        },
      }),
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
