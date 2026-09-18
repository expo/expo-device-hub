import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { ControlInputQueue, SocketControlWriter } from "./control-input-queue.ts";
import { GrpcVideoPacketQueue } from "./grpc-session.ts";
import {
  GpuPacketReader,
  gpuSettingsCommand,
  gpuStreamSize,
  splitGpuAccessUnit,
} from "./gpu-packet.ts";
import { H264StartupGate } from "./h264-readiness.ts";
import { compileGesture } from "./input.ts";
import { startScrcpyControl, type ScrcpyControlSession, type VideoPacket } from "./scrcpy.ts";
import type { EmuSession, StartEmuSessionOptions, StreamFailure } from "./stream-session.ts";

const activeSerials = new Set<string>();

/** Explicit opt-in replacement for video only; scrcpy remains the control transport. */
export async function startGpuExperimentSession(
  options: StartEmuSessionOptions,
  socketPath: string
): Promise<EmuSession> {
  if (options.mode !== "scrcpy" || options.inputSource !== "scrcpy")
    throw new Error(
      "GPU experiment requires scrcpy control mode; capture comes from the native socket"
    );
  if (!socketPath.startsWith("/")) throw new Error("GPU experiment socket path must be absolute");
  if (activeSerials.has(options.serial))
    throw new Error("GPU experiment already has a session for this device");
  activeSerials.add(options.serial);

  // Video arrives on the native socket; scrcpy is started later for input only.
  const socket = createConnection(socketPath);
  const videoQueue = new GrpcVideoPacketQueue(16 * 1024 * 1024);
  const startupGate = new H264StartupGate();
  const failureListeners = new Set<(failure: StreamFailure) => void>();
  const frameWaiters: ((packet: VideoPacket | null) => void)[] = [];
  const fallbackAbortController = new AbortController();
  const signal = options.signal ?? fallbackAbortController.signal;
  let control: ScrcpyControlSession | null = null;
  let controls: ControlInputQueue | null = null;
  let closed = false,
    failed: StreamFailure | null = null;
  let closeTask: Promise<void> | null = null;
  let receivedHandshake = false,
    packets = 0,
    bytes = 0,
    keyRequests = 0,
    lastKeyRequestAt = 0;
  let lastPresentationTimestamp = -1n;
  let sps: Buffer | null = null,
    pps: Buffer | null = null,
    config: Buffer | null = null;
  const meta = { deviceName: "GPU capture experiment", codecId: "h264", width: 0, height: 0 };
  let sourceFps = 0,
    streamFps = 0,
    receivedSettingsAcknowledgement = false;
  const nativeSize = { width: 0, height: 0 };
  const maxSize = options.maxSize ?? 0;

  // Failure wakes startup and pending readers; close owns resource cleanup.
  const fail = (error: unknown) => {
    if (failed || closed) return;
    const cause = error instanceof Error ? error : new Error(String(error));
    failed = { message: cause.message, code: "gpu-capture-error" };
    startupGate.fail(cause);
    socket.destroy();
    for (const listener of failureListeners) listener(failed);
    while (frameWaiters.length) frameWaiters.shift()!(null);
  };

  const requestKeyframe = () => {
    if (closed || failed || socket.destroyed) return;
    const now = Date.now();
    if (now - lastKeyRequestAt < 200) return;
    lastKeyRequestAt = now;
    keyRequests++;
    socket.write("K", error => {
      if (error) fail(error);
    });
  };

  // Apply the queue's drop/recovery policy before waking readers or startup.
  const push = (packet: VideoPacket) => {
    const result = videoQueue.push(packet);
    if (result.needsKeyFrame) requestKeyframe();
    if (packet.type === "frame" && result.queued) startupGate.observe(packet);
    while (frameWaiters.length) {
      const next = videoQueue.shift();
      if (!next) break;
      frameWaiters.shift()!(next);
    }
  };

  // Wire order: native-size hello (2), settings acknowledgement (3), video (0/1).
  const packetReader = new GpuPacketReader(record => {
    if (record.flags === 2) {
      if (receivedHandshake) throw new Error("Unexpected second GPU stream handshake");
      receivedHandshake = true;
      nativeSize.width = record.width;
      nativeSize.height = record.height;
      sourceFps = record.fps;
      Object.assign(meta, gpuStreamSize(nativeSize.width, nativeSize.height, maxSize));
      streamFps = options.maxFps || sourceFps;
      socket.write(gpuSettingsCommand(maxSize, streamFps, options.bitRate ?? 12_000_000), error => {
        if (error) fail(error);
      });
      return;
    }
    if (
      !receivedHandshake ||
      record.width !== meta.width ||
      record.height !== meta.height ||
      record.fps !== streamFps
    )
      throw new Error("GPU stream does not match the requested settings");
    if (record.flags === 3) {
      if (receivedSettingsAcknowledgement)
        throw new Error("Unexpected second GPU settings acknowledgement");
      receivedSettingsAcknowledgement = true;
      requestKeyframe();
      return;
    }
    if (!receivedSettingsAcknowledgement)
      throw new Error("GPU stream arrived before settings acknowledgement");
    if (record.pts <= lastPresentationTimestamp)
      throw new Error("GPU stream timestamp did not increase");
    lastPresentationTimestamp = record.pts;
    packets++;
    bytes += record.data.length;
    const accessUnit = splitGpuAccessUnit(record.data);
    // Cache SPS/PPS across access units; publish changed configuration before pictures.
    sps = accessUnit.sps ?? sps;
    pps = accessUnit.pps ?? pps;
    if (sps && pps) {
      const next = Buffer.concat([sps, pps]);
      if (!config?.equals(next)) {
        config = next;
        push({ type: "frame", data: next, pts: record.pts, isConfig: true, isKey: false });
      }
    }
    if (accessUnit.data.length)
      push({
        type: "frame",
        data: accessUnit.data,
        pts: record.pts,
        isConfig: false,
        isKey: accessUnit.isIdr,
      });
  });

  socket.on("data", chunk => {
    try {
      packetReader.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    } catch (error) {
      fail(error);
    }
  });
  socket.on("error", fail);
  socket.on("end", () => {
    try {
      packetReader.end();
    } catch (error) {
      fail(error);
    }
  });
  socket.on("close", () => fail(new Error("Native GPU capture connection closed")));

  // Share one cleanup promise across explicit close and failed startup.
  const close = (): Promise<void> => {
    if (closeTask) return closeTask;
    closed = true;
    activeSerials.delete(options.serial);
    socket.destroy();
    controls?.close(new Error("GPU experiment session closed"));
    videoQueue.clear();
    while (frameWaiters.length) frameWaiters.shift()!(null);
    failureListeners.clear();
    closeTask = Promise.resolve(control?.close());
    return closeTask;
  };

  try {
    // Wait for decodable video before starting the independent scrcpy input transport.
    await startupGate.wait(signal, 15_000);
    control = await startScrcpyControl(options);
    if (signal.aborted || failed) throw new Error("GPU experiment startup interrupted");
    const writer = new SocketControlWriter(control.controlSocket);
    control.controlSocket.on("error", fail);
    control.proc.on("exit", () => fail(new Error("GPU experiment control process exited")));
    controls = new ControlInputQueue({
      dispatcher: {
        async dispatchGesture(gesture, _screen, inputSignal) {
          for (const step of compileGesture(gesture, nativeSize).steps) {
            if (step.delayMs > 0) await delay(step.delayMs, undefined, { signal: inputSignal });
            await writer.write(step.packet, inputSignal);
          }
        },
        async resetVideo(inputSignal) {
          inputSignal.throwIfAborted();
          requestKeyframe();
        },
        close(reason) {
          writer.close(reason);
        },
      },
    });
    console.warn(
      `[GPU EXPERIMENT] ${options.serial}: gfxstream → CUDA → NVENC, ${meta.width}x${meta.height}@${streamFps} (native ${nativeSize.width}x${nativeSize.height}); scrcpy controls only`
    );
    return {
      // Preserve the existing public mode contract under the private override.
      // /health.captureBackend identifies the actual capture implementation.
      mode: options.mode,
      inputSource: "scrcpy",
      serial: options.serial,
      meta,
      controls,
      diagnostics: () => ({
        experimentalGpuCapture: {
          backend: "gfxstream-cuda-nvenc",
          encoderName: "h264_nvenc",
          packets,
          bytes,
          requestedKeyFrames: keyRequests,
          queuedBytes: videoQueue.byteLength,
          fps: streamFps,
          nativeSize: { ...nativeSize },
          streamSize: { width: meta.width, height: meta.height },
          maxSize,
        },
      }),
      readFrame() {
        if (closed || failed) return Promise.resolve(null);
        const packet = videoQueue.shift();
        return packet
          ? Promise.resolve(packet)
          : new Promise(resolve => frameWaiters.push(resolve));
      },
      onFatal(listener) {
        failureListeners.add(listener);
        if (failed) listener(failed);
        return () => {
          failureListeners.delete(listener);
        };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
