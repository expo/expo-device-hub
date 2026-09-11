import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { ControlInputQueue, SocketControlWriter } from "./control-input-queue.ts";
import { GrpcVideoPacketQueue } from "./grpc-session.ts";
import { GpuPacketReader, splitGpuAccessUnit } from "./gpu-packet.ts";
import { H264StartupGate } from "./h264-readiness.ts";
import { compileGesture } from "./input.ts";
import { startScrcpyControl, type ScrcpyControlSession, type VideoPacket } from "./scrcpy.ts";
import type { EmuSession, StartEmuSessionOptions, StreamFailure } from "./stream-session.ts";

const activeSerials = new Set<string>();

/** Explicit opt-in replacement for video only; scrcpy remains the control transport. */
export async function startGpuExperimentSession(
  options: StartEmuSessionOptions,
  socketPath: string,
): Promise<EmuSession> {
  if (options.mode !== "scrcpy" || options.inputSource !== "scrcpy")
    throw new Error("GPU experiment requires scrcpy control mode; capture comes from the native socket");
  if (!socketPath.startsWith("/")) throw new Error("GPU experiment socket path must be absolute");
  if (activeSerials.has(options.serial))
    throw new Error("GPU experiment settings are fixed; stop the session before replacing it");
  activeSerials.add(options.serial);
  const socket = createConnection(socketPath);
  const queue = new GrpcVideoPacketQueue(16 * 1024 * 1024);
  const startup = new H264StartupGate();
  const listeners = new Set<(failure: StreamFailure) => void>();
  const waiters: ((packet: VideoPacket | null) => void)[] = [];
  const abort = new AbortController();
  const signal = options.signal ?? abort.signal;
  let control: ScrcpyControlSession | null = null;
  let controls: ControlInputQueue | null = null;
  let closed = false, failed: StreamFailure | null = null;
  let closeTask: Promise<void> | null = null;
  let hello = false, packets = 0, bytes = 0, keyRequests = 0, lastKeyRequest = 0;
  let lastPts = -1n;
  let sps: Buffer | null = null, pps: Buffer | null = null, config: Buffer | null = null;
  const meta = { deviceName: "GPU capture experiment", codecId: "h264", width: 0, height: 0 };
  let sourceFps = 0;
  const fail = (error: unknown) => {
    if (failed || closed) return;
    const cause = error instanceof Error ? error : new Error(String(error));
    failed = { message: cause.message, code: "gpu-capture-error" };
    startup.fail(cause);socket.destroy();
    for (const listener of listeners) listener(failed);
    while (waiters.length) waiters.shift()!(null);
  };
  const requestKey = () => {
    if (closed || failed || socket.destroyed) return;
    const now = Date.now();
    if (now - lastKeyRequest < 200) return;
    lastKeyRequest = now;keyRequests++;
    socket.write("K", error => { if (error) fail(error); });
  };
  const push = (packet: VideoPacket) => {
    const result = queue.push(packet);
    if (result.needsKeyFrame) requestKey();
    if (packet.type === "frame" && result.queued) startup.observe(packet);
    while (waiters.length) {
      const next = queue.shift();if (!next) break;
      waiters.shift()!(next);
    }
  };
  const reader = new GpuPacketReader(record => {
    if (record.flags === 2) {
      if (hello) throw new Error("Unexpected second GPU stream handshake");
      hello = true;meta.width = record.width;meta.height = record.height;sourceFps = record.fps;
      if (options.maxSize && Math.max(meta.width, meta.height) > options.maxSize)
        throw new Error("GPU experiment does not resize; use --max-dimension 0 for native resolution");
      if (options.maxFps && options.maxFps !== sourceFps)
        throw new Error("GPU experiment FPS must match the injected encoder");
      requestKey();return;
    }
    if (!hello || record.width !== meta.width || record.height !== meta.height || record.fps !== sourceFps)
      throw new Error("GPU stream dimensions changed; restart the fixed-size experiment");
    if (record.pts <= lastPts) throw new Error("GPU stream timestamp did not increase");
    lastPts = record.pts;packets++;bytes += record.data.length;
    const unit = splitGpuAccessUnit(record.data);
    sps = unit.sps ?? sps;pps = unit.pps ?? pps;
    if (sps && pps) {
      const next = Buffer.concat([sps, pps]);
      if (!config?.equals(next)) {
        config = next;push({ type: "frame", data: next, pts: record.pts, isConfig: true, isKey: false });
      }
    }
    if (unit.data.length)
      push({ type: "frame", data: unit.data, pts: record.pts, isConfig: false, isKey: unit.isIdr });
  });
  socket.on("data", chunk => { try { reader.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk); } catch (error) { fail(error); } });
  socket.on("error", fail);
  socket.on("end", () => { try { reader.end(); } catch (error) { fail(error); } });
  socket.on("close", () => fail(new Error("Native GPU capture connection closed")));
  const close = (): Promise<void> => {
    if (closeTask) return closeTask;
    closed = true;activeSerials.delete(options.serial);socket.destroy();
    controls?.close(new Error("GPU experiment session closed"));queue.clear();
    while (waiters.length) waiters.shift()!(null);
    listeners.clear();
    closeTask = Promise.resolve(control?.close());
    return closeTask;
  };
  try {
    await startup.wait(signal, 15_000);
    control = await startScrcpyControl(options);
    if (signal.aborted || failed) throw new Error("GPU experiment startup interrupted");
    const writer = new SocketControlWriter(control.controlSocket);
    control.controlSocket.on("error", fail);
    control.proc.on("exit", () => fail(new Error("GPU experiment control process exited")));
    controls = new ControlInputQueue({ dispatcher: {
      async dispatchGesture(gesture, _screen, inputSignal) {
        for (const step of compileGesture(gesture, meta).steps) {
          if (step.delayMs > 0) await delay(step.delayMs, undefined, { signal: inputSignal });
          await writer.write(step.packet, inputSignal);
        }
      },
      async resetVideo(inputSignal) { inputSignal.throwIfAborted();requestKey(); },
      close(reason) { writer.close(reason); },
    } });
    console.warn(`[GPU EXPERIMENT] ${options.serial}: gfxstream → CUDA → NVENC, ${meta.width}x${meta.height}@${sourceFps}; scrcpy controls only`);
    return {
      // Preserve the existing public mode contract under the private override.
      // /health.captureBackend identifies the actual capture implementation.
      mode: options.mode, inputSource: "scrcpy", serial: options.serial, meta, controls,
      diagnostics: () => ({ experimentalGpuCapture: {
        backend: "gfxstream-cuda-nvenc", encoderName: "h264_nvenc", packets, bytes,
        requestedKeyFrames: keyRequests, queuedBytes: queue.byteLength, fps: sourceFps,
      } }),
      readFrame() {
        if (closed || failed) return Promise.resolve(null);
        const packet = queue.shift();
        return packet ? Promise.resolve(packet) : new Promise(resolve => waiters.push(resolve));
      },
      onFatal(listener) { listeners.add(listener);if (failed) listener(failed);return () => { listeners.delete(listener); }; },
      close,
    };
  } catch (error) { await close();throw error; }
}
