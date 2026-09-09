import { buildCodecString, scanAU } from "./h264";
import {
  controlAcknowledgementMessage,
  logControlAcknowledgement,
} from "./control-ack";
import { epochNowMs, parseFramePacket } from "../../shared/frame-meta";
import {
  StreamSessionResources,
  beginStreamGeneration,
  createStreamLifecycle,
  deriveStreamDisplayStatus,
  isCurrentStreamGeneration,
  isStreamFatalStatus,
  reduceStreamLifecycle,
  type StreamGenerationReason,
  type StreamFatalStatus,
  type StreamLifecycleState,
  type StreamPhase,
} from "./stream-lifecycle";

// The worker owns the whole WebSocket → decode → present pipeline so that
// main-thread work (React renders, health polling, panels) can never stall
// frame presentation, and vice versa.

// How deep the decoder's pending queue may grow before we jump to a keyframe to
// shed latency. Hardware decoders keep a multi-frame pipeline, so a small value
// like 4 trips on every transient hiccup; 12 (~200ms at 60fps) tolerates spikes
// while still bounding latency.
const SOFT_DECODE_QUEUE_SIZE = 12;
const DECODER_RECOVERY_COOLDOWN_MS = 500;
const KEYFRAME_REQUEST_COOLDOWN_MS = 400;
const FRAME_QUEUE_SIZE = 3;
const PENDING_TIMING_LIMIT = 256;
const STATS_INTERVAL_MS = 1000;

export type StreamStats = {
  fps: number;
  decodeQueue: number;
  transitMs: number | null;
  e2eMs: number | null;
  codec: string | null;
  rendered: boolean;
};

type StreamWorkerEventPayload =
  | { type: "lifecycle"; generation: number; state: StreamLifecycleState }
  | { type: "status"; generation: number; status: string }
  | { type: "session"; generation: number; size: { width: number; height: number } }
  | { type: "rendered"; generation: number; at: number }
  | { type: "stats"; generation: number; stats: StreamStats }
  | { type: "control-error"; generation: number; message: string }
  | {
      type: "control-dropped";
      generation: number;
      reason: "socket-not-open" | "send-failed";
    };

export type StreamWorkerEvent = StreamWorkerEventPayload & {
  clientEpoch: number;
};

type WorkerCommand =
  | { type: "init"; clientEpoch: number; canvas: OffscreenCanvas; url: string }
  | { type: "connect"; clientEpoch: number }
  | { type: "send"; clientEpoch: number; text: string }
  | { type: "stop"; clientEpoch: number };

// Typed against the worker global's message surface only, to avoid pulling the
// whole WebWorker lib into the DOM-flavored UI tsconfig.
const workerPort = self as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
};

// requestAnimationFrame is available in dedicated workers everywhere WebCodecs
// is, but fall back to a vsync-ish timer just in case.
const scheduleFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16) as unknown as number;
const cancelFrame: (handle: number) => void =
  typeof cancelAnimationFrame === "function" ? (h) => cancelAnimationFrame(h) : (h) => clearTimeout(h);

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let url = "";
let ws: WebSocket | null = null;
let stopped = false;
let reconnectDelay = 500;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let decoder: VideoDecoder | null = null;
let sawKeyframe = false;
let frameIdx = 0;
let renderHandle = 0;
let lastDecoderRecoveryAt = Number.NEGATIVE_INFINITY;
let lastKeyframeRequestAt = Number.NEGATIVE_INFINITY;
let droppingUntilKeyframe = false;
let lastPostedStatus: string | null = null;
let controlDropNotifiedGeneration: number | null = null;
let lifecycle = createStreamLifecycle(epochNowMs(), "stopped");
let activeClientEpoch = 0;
let initFailureStatus: StreamFatalStatus | null = null;

// Per-frame receive/server timestamps keyed by chunk timestamp, so decoded
// VideoFrames (which carry the same timestamp) can be matched back for
// latency measurement.
type FrameTiming = { recvMs: number; serverTsMs: number | null };
const resources = new StreamSessionResources<VideoFrame, FrameTiming>({
  frameCapacity: FRAME_QUEUE_SIZE,
  timingCapacity: PENDING_TIMING_LIMIT,
});
let renderedSinceTick = 0;
let transitSumMs = 0;
let transitCount = 0;
let e2eSumMs = 0;
let e2eCount = 0;

const postEvent = (event: StreamWorkerEventPayload) =>
  workerPort.postMessage({ ...event, clientEpoch: activeClientEpoch });

const validClientEpoch = (value: number) =>
  Number.isSafeInteger(value) && value > 0;

const postLifecycle = () => {
  postEvent({
    type: "lifecycle",
    generation: lifecycle.generation,
    state: { ...lifecycle },
  });
};

const postStatus = (status: string, force = false) => {
  if (!force && lastPostedStatus === status) return;
  lastPostedStatus = status;
  postEvent({ type: "status", generation: lifecycle.generation, status });
};

const postDerivedStatus = (now = epochNowMs(), force = false) => {
  postStatus(deriveStreamDisplayStatus(lifecycle, now), force);
};

const postStats = (includeLifecycleSnapshot = true) => {
  const generation = lifecycle.generation;
  const stats: StreamStats = {
    fps: renderedSinceTick,
    decodeQueue: decoder?.decodeQueueSize ?? 0,
    transitMs: transitCount > 0 ? Math.round((transitSumMs / transitCount) * 10) / 10 : null,
    e2eMs: e2eCount > 0 ? Math.round((e2eSumMs / e2eCount) * 10) / 10 : null,
    codec: lifecycle.codec,
    rendered: lifecycle.rendered,
  };
  renderedSinceTick = 0;
  transitSumMs = 0;
  transitCount = 0;
  e2eSumMs = 0;
  e2eCount = 0;
  postDerivedStatus();
  if (includeLifecycleSnapshot) postLifecycle();
  postEvent({ type: "stats", generation, stats });
};

const cancelRender = () => {
  if (renderHandle) {
    cancelFrame(renderHandle);
    renderHandle = 0;
  }
};

const closeDecoderInstance = () => {
  const activeDecoder = decoder;
  decoder = null;
  if (!activeDecoder) return;
  try {
    if (activeDecoder.state !== "closed") activeDecoder.close();
  } catch {}
};

/** Releases every object and counter owned by the current video generation. */
const resetSessionResources = () => {
  closeDecoderInstance();
  cancelRender();
  resources.reset();
  sawKeyframe = false;
  frameIdx = 0;
  lastDecoderRecoveryAt = Number.NEGATIVE_INFINITY;
  lastKeyframeRequestAt = Number.NEGATIVE_INFINITY;
  droppingUntilKeyframe = false;
  renderedSinceTick = 0;
  transitSumMs = 0;
  transitCount = 0;
  e2eSumMs = 0;
  e2eCount = 0;
  controlDropNotifiedGeneration = null;
};

const beginWorkerGeneration = (
  phase: StreamPhase,
  reason: StreamGenerationReason,
  at = epochNowMs(),
): number => {
  lifecycle = beginStreamGeneration(lifecycle, { phase, reason, at });
  resetSessionResources();
  lastPostedStatus = null;
  postLifecycle();
  postDerivedStatus(at, true);
  postStats(false);
  return lifecycle.generation;
};

const publishInitFailure = (status: StreamFatalStatus) => {
  initFailureStatus = status;
  // A replayed effect requires a fresh connect boundary carrying its current
  // client epoch; otherwise correctly rejected old events leave it waiting.
  beginWorkerGeneration("stopped", "connect");
  postStatus(status, true);
};

const applyLifecycle = (
  transition: Parameters<typeof reduceStreamLifecycle>[1],
  publish = false,
) => {
  const next = reduceStreamLifecycle(lifecycle, transition);
  if (next === lifecycle) return false;
  lifecycle = next;
  if (publish) {
    postLifecycle();
    postDerivedStatus(transition.at);
  }
  return true;
};

const requestKeyframe = (generation = lifecycle.generation) => {
  if (!isCurrentStreamGeneration(lifecycle, generation)) return;
  const now = performance.now();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (now - lastKeyframeRequestAt < KEYFRAME_REQUEST_COOLDOWN_MS) return;
  lastKeyframeRequestAt = now;
  try {
    ws.send(JSON.stringify({ type: "reset-video", ack: false }));
  } catch {
    // The socket close callback owns reconnect. A failed recovery request must
    // not crash the worker or cause controls to be queued for another socket.
  }
};

// Soft recovery: the pipeline fell behind but the decoder is still healthy.
// Keep it configured (no close/reconfigure cost, no SPS re-init) and just
// drop incoming deltas until the next keyframe to shed accumulated latency.
// Frames already inside the decoder keep draining to the canvas meanwhile,
// so the stream stays smooth instead of freezing on a teardown.
const recoverToKeyframe = () => {
  const now = performance.now();
  if (now - lastDecoderRecoveryAt < DECODER_RECOVERY_COOLDOWN_MS && droppingUntilKeyframe) return;
  lastDecoderRecoveryAt = now;
  droppingUntilKeyframe = true;
  requestKeyframe(lifecycle.generation);
};

// Hard recovery: the decoder itself errored. Tear it down and rebuild from
// the next keyframe's SPS/PPS.
const beginDecoderRecovery = () => {
  const now = performance.now();
  if (
    lifecycle.phase === "recovering" &&
    now - lastDecoderRecoveryAt < DECODER_RECOVERY_COOLDOWN_MS &&
    droppingUntilKeyframe
  ) {
    return;
  }
  const generation = beginWorkerGeneration("recovering", "decoder-recovery");
  lastDecoderRecoveryAt = now;
  droppingUntilKeyframe = true;
  requestKeyframe(generation);
};

const renderFromQueue = (generation: number) => {
  renderHandle = 0;
  if (!isCurrentStreamGeneration(lifecycle, generation) || !canvas || !ctx) return;

  // Latency-first policy: each vsync, present the NEWEST decoded frame and
  // discard the staler ones still queued. They were superseded before they
  // could be shown, so drawing them would only add display lag. Showing the
  // freshest frame keeps glass-to-glass latency near one vsync interval
  // instead of growing with queue depth. The queue stays as a small burst
  // absorber.
  const frame = resources.takeLatestFrame();
  if (!frame) return;
  if (!isCurrentStreamGeneration(lifecycle, generation)) {
    frame.close();
    return;
  }

  try {
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }
    ctx.drawImage(frame, 0, 0);
  } catch (error) {
    console.error("VideoFrame draw failed", error);
    resources.takeTiming(frame.timestamp);
    frame.close();
    beginDecoderRecovery();
    return;
  }

  const timing = resources.takeTiming(frame.timestamp);
  if (timing) {
    if (timing.serverTsMs !== null) {
      e2eSumMs += epochNowMs() - timing.serverTsMs;
      e2eCount++;
    }
  }
  frame.close();
  const firstRenderedFrame = !lifecycle.rendered;
  const renderedAt = epochNowMs();
  applyLifecycle({ type: "frame-rendered", generation, at: renderedAt });
  if (firstRenderedFrame && lifecycle.rendered) {
    postLifecycle();
    postDerivedStatus(renderedAt, true);
    // Tell the main thread right away, before the next stats tick — the first
    // health poll races against it and would otherwise latch "waiting for video".
    postEvent({ type: "rendered", generation, at: renderedAt });
  }
  renderedSinceTick++;
};

const ensureDecoder = (spsBytes: Uint8Array, generation: number): boolean => {
  if (!isCurrentStreamGeneration(lifecycle, generation)) return false;
  if (decoder?.state === "configured") return true;
  closeDecoderInstance();
  if (!ctx) return false;
  const codec = buildCodecString(spsBytes);
  let dec: VideoDecoder;
  dec = new VideoDecoder({
    output: (frame) => {
      if (decoder !== dec || !isCurrentStreamGeneration(lifecycle, generation)) {
        frame.close();
        return;
      }
      resources.pushFrame(frame);
      if (!renderHandle) {
        renderHandle = scheduleFrame(() => renderFromQueue(generation));
      }
    },
    error: (e) => {
      if (decoder !== dec || !isCurrentStreamGeneration(lifecycle, generation)) return;
      console.error("VideoDecoder error", e);
      postStatus("decoder error");
      beginDecoderRecovery();
    },
  });
  try {
    dec.configure({ codec, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
    if (!isCurrentStreamGeneration(lifecycle, generation)) {
      dec.close();
      return false;
    }
    decoder = dec;
    applyLifecycle(
      { type: "decoder-configured", generation, at: epochNowMs(), codec },
      true,
    );
    console.log("VideoDecoder configured:", codec);
    return true;
  } catch (e) {
    console.error("VideoDecoder configure failed", e);
    try {
      dec.close();
    } catch {}
    postStatus("decoder config failed");
    requestKeyframe(generation);
    return false;
  }
};

const feedFrame = (raw: ArrayBuffer, generation: number) => {
  if (!isCurrentStreamGeneration(lifecycle, generation)) return;
  const recvMs = epochNowMs();
  let packet: ReturnType<typeof parseFramePacket>;
  try {
    packet = parseFramePacket(raw);
  } catch (error) {
    console.error("invalid frame packet", error);
    beginDecoderRecovery();
    return;
  }
  applyLifecycle({ type: "packet-received", generation, at: recvMs });
  if (packet.serverTsMs !== null) {
    transitSumMs += recvMs - packet.serverTsMs;
    transitCount++;
  }
  const needsScan =
    packet.isKey === null ||
    (packet.isKey && (!decoder || decoder.state !== "configured" || droppingUntilKeyframe));
  const scanned = needsScan ? scanAU(packet.data) : null;
  const isKey = packet.isKey ?? scanned?.isKey ?? false;
  const spsBytes = scanned?.spsBytes ?? null;
  if (spsBytes && !ensureDecoder(spsBytes, generation)) return;

  if (droppingUntilKeyframe) {
    if (!isKey) return;
    if (!decoder || decoder.state !== "configured") {
      requestKeyframe(generation);
      return;
    }
    droppingUntilKeyframe = false;
  }

  if (!decoder || decoder.state !== "configured") {
    if (!isKey) requestKeyframe(generation);
    return;
  }

  if (decoder.decodeQueueSize > SOFT_DECODE_QUEUE_SIZE) {
    recoverToKeyframe();
    return;
  }

  if (!sawKeyframe) {
    if (!isKey) {
      requestKeyframe(generation);
      return;
    }
    sawKeyframe = true;
  }
  const timestamp = packet.timestamp ?? Math.round((frameIdx * 1_000_000) / 60);
  try {
    decoder.decode(
      new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp,
        data: packet.data,
      }),
    );
    frameIdx++;
    resources.rememberTiming(timestamp, { recvMs, serverTsMs: packet.serverTsMs });
    if (isKey) {
      applyLifecycle(
        { type: "keyframe-submitted", generation, at: recvMs },
        !lifecycle.rendered,
      );
    }
  } catch (e) {
    console.error("decode failed", e);
    beginDecoderRecovery();
  }
};

const connect = (reason: "connect" | "reconnect") => {
  if (stopped) return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  const previousSocket = ws;
  ws = null;
  try {
    previousSocket?.close();
  } catch {}
  beginWorkerGeneration("connecting", reason);

  let sock: WebSocket;
  try {
    sock = new WebSocket(url);
  } catch (error) {
    console.error("WebSocket creation failed", error);
    beginWorkerGeneration("disconnected", "disconnect");
    postStatus("connection error", true);
    retryTimer = setTimeout(() => connect("reconnect"), reconnectDelay);
    return;
  }
  sock.binaryType = "arraybuffer";
  ws = sock;
  sock.onopen = () => {
    if (stopped || ws !== sock) return;
    reconnectDelay = 500;
    controlDropNotifiedGeneration = null;
    applyLifecycle(
      { type: "socket-open", generation: lifecycle.generation, at: epochNowMs() },
      true,
    );
  };
  sock.onerror = () => {
    if (stopped || ws !== sock) return;
    postStatus("connection error");
  };
  sock.onclose = () => {
    if (stopped || ws !== sock) return;
    ws = null;
    const retryIn = reconnectDelay;
    beginWorkerGeneration("disconnected", "disconnect");
    postStatus(`disconnected — retrying in ${Math.round(retryIn / 1000)}s`, true);
    reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 5000);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect("reconnect");
    }, retryIn);
  };
  sock.onmessage = (e) => {
    if (stopped || ws !== sock) return;
    if (typeof e.data === "string") {
      const controlError = controlAcknowledgementMessage(e.data);
      logControlAcknowledgement(e.data);
      if (controlError) {
        postEvent({
          type: "control-error",
          generation: lifecycle.generation,
          message: controlError,
        });
      }
      try {
        const msg = JSON.parse(e.data) as { type?: string; size?: { width: number; height: number } };
        if (
          msg.type === "video-session" &&
          msg.size &&
          Number.isFinite(msg.size.width) &&
          Number.isFinite(msg.size.height)
        ) {
          const generation = beginWorkerGeneration("awaiting-keyframe", "video-session");
          droppingUntilKeyframe = true;
          postEvent({ type: "session", generation, size: msg.size });
          requestKeyframe(generation);
        }
      } catch {}
      return;
    }
    feedFrame(e.data as ArrayBuffer, lifecycle.generation);
  };
};

const start = () => {
  stopped = false;
  if (statsTimer === null) statsTimer = setInterval(postStats, STATS_INTERVAL_MS);
  connect("connect");
};

const stop = () => {
  stopped = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (statsTimer !== null) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  const sock = ws;
  ws = null;
  beginWorkerGeneration("stopped", "stop");
  try {
    sock?.close();
  } catch {}
};

const postControlDropped = (reason: "socket-not-open" | "send-failed") => {
  if (controlDropNotifiedGeneration === lifecycle.generation) return;
  controlDropNotifiedGeneration = lifecycle.generation;
  postEvent({
    type: "control-dropped",
    generation: lifecycle.generation,
    reason,
  });
};

workerPort.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as WorkerCommand;
  switch (msg.type) {
    case "init": {
      if (!validClientEpoch(msg.clientEpoch)) return;
      activeClientEpoch = msg.clientEpoch;
      if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") {
        publishInitFailure("WebCodecs unsupported");
        return;
      }
      canvas = msg.canvas;
      ctx = canvas.getContext("2d", { alpha: false }) as OffscreenCanvasRenderingContext2D | null;
      if (!ctx) {
        publishInitFailure("canvas unavailable");
        return;
      }
      initFailureStatus = null;
      url = msg.url;
      start();
      break;
    }
    case "connect": {
      if (!validClientEpoch(msg.clientEpoch) || msg.clientEpoch < activeClientEpoch) return;
      activeClientEpoch = msg.clientEpoch;
      if (initFailureStatus && isStreamFatalStatus(initFailureStatus)) {
        publishInitFailure(initFailureStatus);
        return;
      }
      if (!canvas || !ctx) return;
      if (stopped) {
        reconnectDelay = 500;
        start();
      }
      break;
    }
    case "send": {
      if (msg.clientEpoch !== activeClientEpoch) break;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        postControlDropped("socket-not-open");
        break;
      }
      try {
        ws.send(msg.text);
      } catch {
        postControlDropped("send-failed");
      }
      break;
    }
    case "stop": {
      if (msg.clientEpoch !== activeClientEpoch) break;
      stop();
      break;
    }
  }
});
