import { useEffect, useRef, type RefObject } from 'react';

import { AvccDemuxer, avcCodecString, isAvccSupported, type AvccChunkType } from './avcc';

export interface UseAvccStreamOptions {
  /** Base serve-sim helper URL, without `/stream.avcc`. */
  url: string;
  enabled: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onFirstFrame?: () => void;
  onFrame?: () => void;
  onDecodedFrame?: () => void;
  onResize?: (width: number, height: number) => void;
  onError?: (message: string) => void;
  onDecoderError?: () => void;
}

const RETRY_DELAY_MS = 1_000;
const FRAME_DURATION_US = 16_667;

/** Decode serve-sim's H.264 AVCC feed into a canvas via WebCodecs. */
export function useAvccStream({
  url,
  enabled,
  canvasRef,
  onFirstFrame,
  onFrame,
  onDecodedFrame,
  onResize,
  onError,
  onDecoderError,
}: UseAvccStreamOptions): void {
  const callbacks = useRef({
    onFirstFrame,
    onFrame,
    onDecodedFrame,
    onResize,
    onError,
    onDecoderError,
  });
  callbacks.current = {
    onFirstFrame,
    onFrame,
    onDecodedFrame,
    onResize,
    onError,
    onDecoderError,
  };

  useEffect(() => {
    if (!enabled || !url || !isAvccSupported()) return;

    const controller = new AbortController();
    const demuxer = new AvccDemuxer();
    let stopped = false;
    let painted = false;
    let decodedFramePainted = false;
    let timestamp = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let decoder: VideoDecoder | null = null;

    const isLive = () => !stopped && !controller.signal.aborted;

    const reportDecodeFailure = (message: string) => {
      if (callbacks.current.onDecoderError) callbacks.current.onDecoderError();
      else callbacks.current.onError?.(message);
    };

    const paint = (source: CanvasImageSource, width: number, height: number, decoded: boolean) => {
      if (!isLive()) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        callbacks.current.onResize?.(width, height);
      }
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(source, 0, 0, width, height);
      callbacks.current.onFrame?.();
      if (decoded && !decodedFramePainted) {
        decodedFramePainted = true;
        callbacks.current.onDecodedFrame?.();
      }
      if (!painted) {
        painted = true;
        callbacks.current.onFirstFrame?.();
      }
    };

    const makeDecoder = () =>
      new VideoDecoder({
        output: (frame) => {
          try {
            if (isLive()) paint(frame, frame.displayWidth, frame.displayHeight, true);
          } finally {
            frame.close();
          }
        },
        error: (decoderError) => reportDecodeFailure(`decoder: ${decoderError.message}`),
      });

    const paintSeed = async (jpeg: Uint8Array) => {
      const bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }));
      try {
        if (isLive()) paint(bitmap, bitmap.width, bitmap.height, false);
      } finally {
        bitmap.close();
      }
    };

    const configureDecoder = (description: Uint8Array) => {
      if (!decoder || decoder.state === 'closed') decoder = makeDecoder();
      try {
        decoder.configure({
          codec: avcCodecString(description),
          description,
          optimizeForLatency: true,
          hardwareAcceleration: 'prefer-hardware',
        });
      } catch (caught) {
        reportDecodeFailure(`config: ${(caught as Error).message}`);
      }
    };

    const decodeFrame = (type: 'keyframe' | 'delta', data: Uint8Array) => {
      if (decoder?.state !== 'configured') return;
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: type === 'keyframe' ? 'key' : 'delta',
            timestamp,
            data,
          }),
        );
        timestamp += FRAME_DURATION_US;
      } catch {
        // Drop an undecodable frame and wait for the next decoder output.
      }
    };

    const handleChunk = (type: AvccChunkType, payload: Uint8Array) => {
      switch (type) {
        case 'seed':
          void paintSeed(payload).catch(() => {});
          break;
        case 'description':
          configureDecoder(payload);
          break;
        case 'keyframe':
        case 'delta':
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
        const response = await fetch(`${url}/stream.avcc`, { signal: controller.signal });
        if (!response.ok) throw new Error(`H.264 stream failed (${response.status})`);
        const reader = response.body?.getReader();
        if (!reader) return;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          for (const chunk of demuxer.push(value)) handleChunk(chunk.type, chunk.payload);
        }
      } catch {
        // Network errors are retried; the parent timeout handles old helpers.
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
      if (decoder && decoder.state !== 'closed') {
        try {
          decoder.close();
        } catch {}
      }
      decoder = null;
    };
  }, [url, enabled, canvasRef]);
}
