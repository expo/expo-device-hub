import { useEffect, useRef } from "react";

export interface UseSimstreamStreamOptions {
  /** Helper base URL, e.g. "http://localhost:3200/helper/<udid>"; the socket is `<url>/simstream`. */
  url: string;
  enabled: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onFirstFrame?: () => void;
  onFrame?: () => void;
  onDecodedFrame?: () => void;
  onError?: (message: string) => void;
}

/** simstream frame header: u8 flags | u32 seq | f64 capture | f64 encodeStart | f64 encoded | f64 sent | u32 inputSeq | f64 inputReceived. */
const HEADER_BYTES = 49;
const RETRY_DELAY_MS = 1000;

/**
 * Decode the simstream engine's H.264 WebSocket feed into `canvasRef`.
 *
 * The engine encodes per viewer and adapts that viewer's bitrate from acks, so every decoded frame
 * is acked. Frames are drawn as soon as they decode, at most one per display refresh: frames that
 * arrive in a burst (e.g. after a network stall) collapse to the newest instead of fast-forwarding.
 */
export function useSimstreamStream({
  url,
  enabled,
  canvasRef,
  onFirstFrame,
  onFrame,
  onDecodedFrame,
  onError,
}: UseSimstreamStreamOptions): void {
  const callbacks = useRef({ onFirstFrame, onFrame, onDecodedFrame, onError });
  callbacks.current = { onFirstFrame, onFrame, onDecodedFrame, onError };

  useEffect(() => {
    if (!enabled || !url || typeof VideoDecoder === "undefined") return;

    let stopped = false;
    let ws: WebSocket | null = null;
    let decoder: VideoDecoder | null = null;
    let config: { codec: string; description: string; width: number; height: number; displayWidth?: number } | null = null;
    let waitingForKeyframe = true;
    let painted = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let latest: VideoFrame | null = null;
    let drawnThisRefresh = false;
    let refreshScheduled = false;

    const socketUrl = `${url.replace(/^http/, "ws").replace(/\/$/, "")}/simstream`;
    const send = (message: object) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };

    const present = (frame: VideoFrame) => {
      drawnThisRefresh = true;
      const canvas = canvasRef.current;
      if (canvas) {
        const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
        context?.drawImage(frame, 0, 0, canvas.width, canvas.height);
      }
      frame.close();
      if (!painted) {
        painted = true;
        callbacks.current.onFirstFrame?.();
        callbacks.current.onDecodedFrame?.();
      }
      callbacks.current.onFrame?.();
    };

    const scheduleRefresh = () => {
      if (refreshScheduled) return;
      refreshScheduled = true;
      requestAnimationFrame(() => {
        refreshScheduled = false;
        drawnThisRefresh = false;
        if (latest) {
          const frame = latest;
          latest = null;
          present(frame);
          scheduleRefresh();
        }
      });
    };

    const teardownDecoder = () => {
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = null;
      config = null;
      latest?.close();
      latest = null;
    };

    const configure = (c: { codec: string; description: string; width: number; height: number; displayWidth?: number; displayHeight?: number }) => {
      if (config && decoder?.state === "configured" && config.codec === c.codec &&
          config.description === c.description && config.width === c.width && config.height === c.height) return;
      teardownDecoder();
      config = c;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = c.displayWidth ?? c.width;
        canvas.height = c.displayHeight ?? c.height;
      }
      decoder = new VideoDecoder({
        output: (frame) => {
          send({ t: "ack", seq: frame.timestamp });
          if (!drawnThisRefresh) {
            present(frame);
          } else {
            latest?.close();
            latest = frame;
          }
          scheduleRefresh();
        },
        error: (error) => {
          teardownDecoder();
          waitingForKeyframe = true;
          send({ t: "keyframe" });
          callbacks.current.onError?.(`simstream decoder error: ${error.message}`);
        },
      });
      decoder.configure({
        codec: c.codec,
        codedWidth: c.width,
        codedHeight: c.height,
        description: Uint8Array.from(atob(c.description), (ch) => ch.charCodeAt(0)),
        optimizeForLatency: true,
        hardwareAcceleration: "prefer-hardware",
      });
      waitingForKeyframe = true;
    };

    const onVisibility = () => send({ t: document.hidden ? "pause" : "resume" });

    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(socketUrl);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        send({ t: "hello", codecs: ["h264"] });
        if (document.hidden) send({ t: "pause" });
      };
      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          const message = JSON.parse(event.data);
          if (message.t === "config") configure(message);
          return;
        }
        const buffer = event.data as ArrayBuffer;
        const view = new DataView(buffer);
        const isKey = (view.getUint8(0) & 1) === 1;
        const seq = view.getUint32(1, true);
        if (!decoder || decoder.state !== "configured") return;
        if (waitingForKeyframe && !isKey) return;
        waitingForKeyframe = false;
        decoder.decode(new EncodedVideoChunk({
          type: isKey ? "key" : "delta",
          timestamp: seq,
          data: new Uint8Array(buffer, HEADER_BYTES),
        }));
      };
      ws.onclose = () => {
        teardownDecoder();
        if (!stopped) retryTimer = setTimeout(connect, RETRY_DELAY_MS);
      };
    };

    document.addEventListener("visibilitychange", onVisibility);
    connect();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
      teardownDecoder();
    };
  }, [url, enabled, canvasRef]);
}
