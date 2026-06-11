import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { buildCodecString, scanAU } from "./h264";

export type DeviceSize = { width: number; height: number };

export type StreamState = {
  status: string;
  fps: number;
  deviceSize: DeviceSize | null;
};

export type Sender = (msg: Record<string, unknown>, ack?: boolean) => void;

type ApiInfo = {
  size: DeviceSize;
  status?: "streaming" | "stopped" | "error";
  lastFrameAt?: string | null;
  lastError?: string | null;
};

const SOFT_DECODE_QUEUE_SIZE = 4;
const HARD_DECODE_QUEUE_SIZE = 16;
const DECODER_RESET_COOLDOWN_MS = 1500;
const KEYFRAME_REQUEST_COOLDOWN_MS = 1500;
const FRAME_QUEUE_SIZE = 2;
const FRAME_META_MAGIC = 0x53454d55; // "SEMU"
const FRAME_META_VERSION = 1;
const FRAME_META_HEADER_BYTES = 16;
const FRAME_FLAG_KEY = 1 << 0;

type FramePacket = {
  data: Uint8Array;
  isKey: boolean | null;
  timestamp: number | null;
};

function parseFramePacket(raw: ArrayBuffer | Uint8Array): FramePacket {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength > FRAME_META_HEADER_BYTES) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, FRAME_META_HEADER_BYTES);
    if (view.getUint32(0, false) === FRAME_META_MAGIC && view.getUint8(4) === FRAME_META_VERSION) {
      const pts = view.getBigUint64(8, false);
      return {
        data: bytes.subarray(FRAME_META_HEADER_BYTES),
        isKey: (view.getUint8(5) & FRAME_FLAG_KEY) !== 0,
        timestamp: pts <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pts) : null,
      };
    }
  }
  return { data: bytes, isKey: null, timestamp: null };
}

export function useStream(canvasRef: RefObject<HTMLCanvasElement>) {
  const [state, setState] = useState<StreamState>({
    status: "connecting…",
    fps: 0,
    deviceSize: null,
  });
  const wsRef = useRef<WebSocket | null>(null);

  const send = useCallback<Sender>((msg, ack = true) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(ack ? msg : { ...msg, ack: false }));
  }, []);

  useEffect(() => {
    const canDecode = "VideoDecoder" in globalThis && "EncodedVideoChunk" in globalThis;
    if (!canDecode) {
      setState((s) => ({ ...s, status: "WebCodecs unsupported" }));
      return;
    }

    let cancelled = false;
    let reconnectDelay = 500;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let decoder: VideoDecoder | null = null;
    let sawKeyframe = false;
    let frameIdx = 0;
    let fpsCount = 0;
    let fpsTimer = performance.now();
    let frameQueue: (VideoFrame | null)[] = new Array(FRAME_QUEUE_SIZE).fill(null);
    let frameQueueHead = 0;
    let frameQueueCount = 0;
    let renderRaf = 0;
    let lastDecoderResetAt = 0;
    let lastKeyframeRequestAt = 0;
    let droppingUntilKeyframe = false;
    let healthTimer: ReturnType<typeof setInterval> | null = null;

    const setStatus = (s: string) =>
      setState((prev) => (prev.status === s ? prev : { ...prev, status: s }));

    const resetDecoderQueue = () => {
      if (!decoder || decoder.state === "closed") return;
      const now = performance.now();
      if (now - lastDecoderResetAt < DECODER_RESET_COOLDOWN_MS) return;
      lastDecoderResetAt = now;
      try {
        decoder.reset();
      } catch {}
      sawKeyframe = false;
      frameIdx = 0;
    };

    const requestKeyframe = () => {
      const ws = wsRef.current;
      const now = performance.now();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (now - lastKeyframeRequestAt < KEYFRAME_REQUEST_COOLDOWN_MS) return;
      lastKeyframeRequestAt = now;
      ws.send(JSON.stringify({ type: "reset-video", ack: false }));
    };

    const renderFromQueue = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
      renderRaf = 0;
      if (frameQueueCount === 0) return;

      const tail = (frameQueueHead - frameQueueCount + FRAME_QUEUE_SIZE) % FRAME_QUEUE_SIZE;
      const frame = frameQueue[tail]!;
      frameQueue[tail] = null;
      frameQueueCount--;

      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      ctx.drawImage(frame, 0, 0);
      frame.close();

      fpsCount++;
      const now = performance.now();
      if (now - fpsTimer >= 1000) {
        const fps = Math.round((fpsCount * 1000) / (now - fpsTimer));
        fpsCount = 0;
        fpsTimer = now;
        setState((s) => (s.fps === fps ? s : { ...s, fps }));
      }

      if (frameQueueCount > 0) {
        renderRaf = requestAnimationFrame(() => renderFromQueue(canvas, ctx));
      }
    };

    const ensureDecoder = (spsBytes: Uint8Array) => {
      if (decoder && decoder.state !== "closed") return;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d", { alpha: false, desynchronized: true });
      if (!canvas || !ctx) return;
      const codec = buildCodecString(spsBytes);
      const dec = new VideoDecoder({
        output: (frame) => {
          if (frameQueueCount >= FRAME_QUEUE_SIZE) {
            const tail = (frameQueueHead - frameQueueCount + FRAME_QUEUE_SIZE) % FRAME_QUEUE_SIZE;
            frameQueue[tail]?.close();
            frameQueue[tail] = null;
            frameQueueCount--;
          }
          frameQueue[frameQueueHead] = frame;
          frameQueueHead = (frameQueueHead + 1) % FRAME_QUEUE_SIZE;
          frameQueueCount++;
          if (!renderRaf) {
            renderRaf = requestAnimationFrame(() => renderFromQueue(canvas, ctx));
          }
        },
        error: (e) => {
          console.error("VideoDecoder error", e);
          setStatus("decoder error");
        },
      });
      dec.configure({ codec, optimizeForLatency: true });
      decoder = dec;
      console.log("VideoDecoder configured:", codec);
    };

    const feedFrame = (raw: ArrayBuffer | Uint8Array) => {
      const packet = parseFramePacket(raw);
      const needsScan = packet.isKey === null || (packet.isKey && (!decoder || decoder.state === "closed"));
      const scanned = needsScan ? scanAU(packet.data) : null;
      const isKey = packet.isKey ?? scanned?.isKey ?? false;
      const spsBytes = scanned?.spsBytes ?? null;
      if (spsBytes) ensureDecoder(spsBytes);
      if (!decoder || decoder.state !== "configured") return;

      const queueSize = decoder.decodeQueueSize;
      if (queueSize > HARD_DECODE_QUEUE_SIZE) {
        resetDecoderQueue();
        droppingUntilKeyframe = !isKey;
        requestKeyframe();
        if (!isKey) return;
      } else if (droppingUntilKeyframe) {
        if (!isKey) {
          return;
        }
        droppingUntilKeyframe = false;
        resetDecoderQueue();
      } else if (queueSize > SOFT_DECODE_QUEUE_SIZE) {
        droppingUntilKeyframe = !isKey;
        requestKeyframe();
        if (!isKey) return;
        resetDecoderQueue();
      }

      if (!sawKeyframe) {
        if (!isKey) {
          requestKeyframe();
          return;
        }
        sawKeyframe = true;
      }
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: isKey ? "key" : "delta",
            timestamp: packet.timestamp ?? Math.round((frameIdx * 1_000_000) / 60),
            data: packet.data,
          }),
        );
        frameIdx++;
      } catch (e) {
        console.error("decode failed", e);
      }
    };

    const connect = () => {
      if (cancelled) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/ws?frame-meta=1`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onopen = () => {
        reconnectDelay = 500;
        setStatus("streaming");
      };
      ws.onerror = () => setStatus("connection error");
      ws.onclose = () => {
        if (cancelled) return;
        const retryIn = reconnectDelay;
        setStatus(`disconnected — retrying in ${Math.round(retryIn / 1000)}s`);
        try {
          decoder?.close();
        } catch {}
        decoder = null;
        frameIdx = 0;
        sawKeyframe = false;
        reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 5000);
        retryTimer = setTimeout(connect, retryIn);
      };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") return;
        feedFrame(e.data);
      };
    };

    connect();

    const applyServerStatus = (d: ApiInfo) => {
      const lastFrameAgeMs = d.lastFrameAt ? Date.now() - Date.parse(d.lastFrameAt) : Infinity;
      setState((s) => ({
        ...s,
        deviceSize: d.size,
        status:
          d.status && d.status !== "streaming"
            ? d.lastError || d.status
            : lastFrameAgeMs > 3000
              ? "stream stalled"
              : s.status,
      }));
    };

    fetch("/health")
      .then((r) => r.json() as Promise<ApiInfo>)
      .then((d) => {
        if (cancelled) return;
        applyServerStatus(d);
      })
      .catch(() => {
        if (!cancelled) setStatus("metadata unavailable");
      });

    healthTimer = setInterval(() => {
      fetch("/health")
        .then((r) => r.json() as Promise<ApiInfo>)
        .then((d) => {
          if (!cancelled) applyServerStatus(d);
        })
        .catch(() => {
          if (!cancelled) setStatus("metadata unavailable");
        });
    }, 1500);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (healthTimer) clearInterval(healthTimer);
      try {
        wsRef.current?.close();
      } catch {}
      if (renderRaf) cancelAnimationFrame(renderRaf);
      for (let i = 0; i < FRAME_QUEUE_SIZE; i++) {
        frameQueue[i]?.close();
      }
      frameQueueCount = 0;
      try {
        decoder?.close();
      } catch {}
      wsRef.current = null;
      decoder = null;
    };
  }, [canvasRef]);

  return { state, send };
}
