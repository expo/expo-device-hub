import { useEffect, useRef } from "react";

import { AvccDemuxer, avcCodecString, isAvccSupported, type AvccChunkType } from "./avcc";

interface AvccStreamCallbacks {
  onFirstFrame?: () => void;
  onFrame?: () => void;
  onResize?: (width: number, height: number) => void;
  onError?: (message: string) => void;
}

const RETRY_DELAY_MS = 1000;
const FRAME_DURATION_US = 16_667;

/** Decode serve-sim's H.264 AVCC response into a canvas with WebCodecs. */
export function useAvccStream({
  url,
  enabled,
  canvasRef,
  onFirstFrame,
  onFrame,
  onResize,
  onError,
}: {
  url: string;
  enabled: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
} & AvccStreamCallbacks): void {
  const callbacks = useRef({ onFirstFrame, onFrame, onResize, onError });
  callbacks.current = { onFirstFrame, onFrame, onResize, onError };

  useEffect(() => {
    if (!enabled || !url || !isAvccSupported()) return;

    const controller = new AbortController();
    const demuxer = new AvccDemuxer();
    let stopped = false;
    let painted = false;
    let timestamp = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let decoder: VideoDecoder | null = null;

    const isLive = () => !stopped && !controller.signal.aborted;

    const paint = (source: CanvasImageSource, width: number, height: number) => {
      if (!isLive()) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        callbacks.current.onResize?.(width, height);
      }
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(source, 0, 0, width, height);
      callbacks.current.onFrame?.();
      if (!painted) {
        painted = true;
        callbacks.current.onFirstFrame?.();
      }
    };

    const makeDecoder = () =>
      new VideoDecoder({
        output: (frame) => {
          try {
            if (isLive()) paint(frame, frame.displayWidth, frame.displayHeight);
          } finally {
            frame.close();
          }
        },
        error: (error) => callbacks.current.onError?.(`H.264 decoder failed: ${error.message}`),
      });

    const paintSeed = async (jpeg: Uint8Array) => {
      const bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
      try {
        if (isLive()) paint(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    };

    const configureDecoder = (description: Uint8Array) => {
      if (!decoder || decoder.state === "closed") decoder = makeDecoder();
      try {
        decoder.configure({
          codec: avcCodecString(description),
          description,
          optimizeFor: "latency",
          hardwareAcceleration: "prefer-hardware",
        } as VideoDecoderConfig & { optimizeFor: "latency" });
      } catch (error) {
        callbacks.current.onError?.(
          `H.264 decoder configuration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    const decodeFrame = (type: "keyframe" | "delta", data: Uint8Array) => {
      if (decoder?.state !== "configured") return;
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: type === "keyframe" ? "key" : "delta",
            timestamp,
            data,
          }),
        );
        timestamp += FRAME_DURATION_US;
      } catch {
        // A reconnect starts with a fresh decoder description and keyframe.
      }
    };

    const handleChunk = (type: AvccChunkType, payload: Uint8Array) => {
      switch (type) {
        case "seed":
          void paintSeed(payload).catch(() => {});
          break;
        case "description":
          configureDecoder(payload);
          break;
        case "keyframe":
        case "delta":
          decodeFrame(type, payload);
          break;
      }
    };

    const scheduleRetry = () => {
      if (!isLive() || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void read();
      }, RETRY_DELAY_MS);
    };

    const read = async () => {
      demuxer.reset();
      try {
        const response = await fetch(`${url.replace(/\/$/, "")}/stream.avcc`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) {
          callbacks.current.onError?.(`H.264 stream failed: HTTP ${response.status}`);
          return;
        }
        const reader = response.body?.getReader();
        if (!reader) {
          callbacks.current.onError?.("H.264 stream returned no response body.");
          return;
        }
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          for (const chunk of demuxer.push(value)) handleChunk(chunk.type, chunk.payload);
        }
      } catch {
        // Abort and transient network errors share the reconnect path.
      } finally {
        if (isLive()) scheduleRetry();
      }
    };

    void read();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller.abort();
      demuxer.reset();
      if (decoder && decoder.state !== "closed") {
        try {
          decoder.close();
        } catch {}
      }
    };
  }, [url, enabled, canvasRef]);
}
