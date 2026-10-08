/**
 * Paints one panel's MJPEG feed into an `<img>` as per-frame blob URLs,
 * following serve-sim's `use-mjpeg-stream.ts` and the `SimulatorView` painter
 * (@expo/serve-sim 0.5.0). A fresh object URL per frame lets the 3D scene
 * detect new frames by `img.src`, which a long-lived multipart `<img>` would
 * never change.
 */

import { useEffect, useRef, type RefObject } from 'react';

import { type SessionFetch } from '../session-token';
import { createMjpegFrameParser } from './mjpeg-frame-parser';

const RETRY_MS = 1_000;

export function useMjpegPanel(
  streamUrl: string | null,
  imgRef: RefObject<HTMLImageElement | null>,
  onFrame?: () => void,
  fetchImpl: SessionFetch = fetch,
  onConnecting?: () => void,
): void {
  const onConnectingRef = useRef(onConnecting);
  onConnectingRef.current = onConnecting;
  useEffect(() => {
    if (!streamUrl) return;
    // The element belongs to the same render as this effect; hold it for cleanup.
    const img = imgRef.current;
    if (!img) return;
    const controller = new AbortController();
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pending: string | null = null;
    let painted: string | null = null;
    // The frame the <img> is decoding, revoked on cleanup if it never finishes.
    let decoding: string | null = null;

    // `?raw=1` asks for application/octet-stream: WebKit refuses to expose
    // multipart bodies to fetch()'s ReadableStream.
    const fetchUrl = new URL(streamUrl);
    fetchUrl.searchParams.set('raw', '1');

    const paintNext = () => {
      const next = pending;
      pending = null;
      if (!next) return;
      decoding = next;
      img.onload = () => {
        decoding = null;
        if (painted) URL.revokeObjectURL(painted);
        painted = next;
        onFrame?.();
        if (pending) paintNext();
      };
      img.onerror = () => {
        decoding = null;
        URL.revokeObjectURL(next);
        if (pending) paintNext();
      };
      img.src = next;
    };

    const emit = (jpeg: Uint8Array) => {
      if (stopped) return;
      // Blob copies the bytes, so handing it a subarray view is safe even as
      // the underlying accumulation buffer is reused/compacted.
      const blob = new Blob([jpeg as BlobPart], { type: 'image/jpeg' });
      // Latest frame wins: never queue a decode for every received frame.
      if (pending) URL.revokeObjectURL(pending);
      pending = URL.createObjectURL(blob);
      if (!decoding) paintNext();
    };

    const scheduleRetry = () => {
      if (stopped || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void read();
      }, RETRY_MS);
    };

    const read = async () => {
      onConnectingRef.current?.();
      try {
        const response = await fetchImpl(fetchUrl, { signal: controller.signal });
        const reader = response.body?.getReader();
        if (!reader) {
          scheduleRetry();
          return;
        }
        const parser = createMjpegFrameParser(emit);
        for (;;) {
          const { done, value } = await reader.read();
          if (done || stopped) break;
          if (value && value.length) parser.push(value);
        }
      } catch {
        // Aborted or network error; retried below.
      } finally {
        scheduleRetry();
      }
    };
    void read();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller.abort();
      img.onload = null;
      img.onerror = null;
      img.removeAttribute('src');
      if (pending) URL.revokeObjectURL(pending);
      if (decoding) URL.revokeObjectURL(decoding);
      if (painted) URL.revokeObjectURL(painted);
    };
  }, [streamUrl, imgRef, onFrame, fetchImpl]);
}
