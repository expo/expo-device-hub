import { useCallback, useEffect, useRef, useState } from "react";

import {
  MAX_REQUESTS,
  type CaptureEvent,
  type CaptureMeta,
  type CaptureAttachment,
  type CapturedBody,
  type CapturedRequest,
} from "../../capture/store";
import { openHostEventStream, runHostAction } from "../utils/exec";

export type { CaptureMeta, CaptureAttachment, CapturedBody, CapturedRequest };

/** A stream frame: store events, plus the first meta frame of each (re)subscription. */
export type CaptureStreamFrame = CaptureEvent | { type: "meta"; meta: CaptureMeta; initial: true };

/**
 * The request list after one frame. The server replays its whole list after each initial meta, so
 * that frame empties the list: requests cleared or evicted while disconnected do not linger. Capture
 * turned off (from another viewer, a reboot, or cleanup) removes the session and its bodies with only
 * a `not-enabled` meta, so that empties it too.
 */
export function applyCaptureEvent(requests: CapturedRequest[], event: CaptureStreamFrame): CapturedRequest[] {
  switch (event.type) {
    case "meta":
      return ("initial" in event && event.initial) || event.meta.attachment === "not-enabled" ? [] : requests;
    case "cleared":
      return [];
    case "evicted":
      return requests.filter((request) => request.id !== event.id);
    case "started":
    case "finished": {
      const next = [...requests];
      const at = next.findIndex((request) => request.id === event.request.id);
      if (at === -1) next.push(event.request);
      else next[at] = event.request;
      return next.length > MAX_REQUESTS ? next.slice(next.length - MAX_REQUESTS) : next;
    }
    default:
      return requests;
  }
}

/** How long frames wait when no animation frame comes, as in a hidden tab. */
const HIDDEN_FLUSH_MS = 250;

export interface FrameTimers {
  requestAnimationFrame: (callback: () => void) => number;
  cancelAnimationFrame: (handle: number) => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const browserTimers: FrameTimers = {
  requestAnimationFrame: (callback) => requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Collect items and apply them together. A chatty app sends many frames a second; the ones that arrive
 * within one animation frame render once, on the page that also plays the stream. A hidden tab gets no
 * animation frames, so a timer flushes too and items never pile up.
 */
export function batchFrames<T>(apply: (items: T[]) => void, timers: FrameTimers = browserTimers) {
  let pending: T[] = [];
  let frame: number | null = null;
  let timer: unknown = null;
  const cancel = () => {
    if (frame !== null) timers.cancelAnimationFrame(frame);
    if (timer !== null) timers.clearTimeout(timer);
    frame = null;
    timer = null;
  };
  const flush = () => {
    cancel();
    const items = pending;
    pending = [];
    apply(items);
  };
  return {
    push(item: T) {
      pending.push(item);
      if (frame !== null) return;
      frame = timers.requestAnimationFrame(flush);
      timer = timers.setTimeout(flush, HIDDEN_FLUSH_MS);
    },
    cancel,
  };
}

/** Subscribe to capture SSE; `streamKey` bumps after reboot to resubscribe. */
export function useCaptureStream(
  path: string,
  streamKey = 0,
): {
  meta: CaptureMeta | null;
  requests: CapturedRequest[];
  errored: boolean;
  clear: () => Promise<void>;
  setMeta: (meta: CaptureMeta) => void;
} {
  const [meta, setMeta] = useState<CaptureMeta | null>(null);
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [errored, setErrored] = useState(false);
  const subscribedPath = useRef<string | null>(null);

  const clear = useCallback(async () => {
    const device = new URL(path, "http://local").searchParams.get("device");
    if (!device) return;
    // The host's cleared event empties the list, so a request recorded after the clear stays.
    const result = await runHostAction("capture.clear", { udid: device });
    if (result.exitCode !== 0) throw new Error(result.stderr || "Requests could not be cleared.");
  }, [path]);

  useEffect(() => {
    setErrored(false);
    setRequests([]);
    // A resubscription after a reboot keeps the meta its caller just set until the first frame.
    if (subscribedPath.current !== path) setMeta(null);
    subscribedPath.current = path;
    const stream = openHostEventStream(path);
    const batch = batchFrames<CaptureStreamFrame>((events) => setRequests((prev) => events.reduce(applyCaptureEvent, prev)));
    stream.onmessage = ({ data }) => {
      try {
        const event = JSON.parse(data) as CaptureStreamFrame;
        setErrored(false);
        if (event.type === "meta") setMeta(event.meta);
        batch.push(event);
      } catch {
        // Ignore malformed frames.
      }
    };
    stream.onerror = () => setErrored(true);
    return () => {
      batch.cancel();
      stream.close();
    };
  }, [path, streamKey]);

  return { meta, requests, errored, clear, setMeta };
}

// Request IDs are per device; always include the device in body lookups.
/**
 * A body lookup: the body (null when none is kept, with `dropped` when the host dropped it for its
 * memory budget), or why the lookup failed.
 */
export type CapturedBodyLookup = { body: CapturedBody | null; dropped?: true } | { error: string };

/** A failed lookup is reported as an error, so it never looks like a request without a body. */
export function readCapturedBodyResult(result: { exitCode: number; stdout: string; stderr: string }): CapturedBodyLookup {
  if (result.exitCode !== 0) return { error: result.stderr || "The body could not be loaded." };
  if (!result.stdout) return { body: null };
  try {
    const parsed = JSON.parse(result.stdout) as CapturedBody | { dropped?: unknown };
    if ((parsed as { dropped?: unknown }).dropped === true) return { body: null, dropped: true };
    return { body: parsed as CapturedBody };
  } catch {
    return { error: "The body could not be read." };
  }
}

export async function fetchCapturedBody(id: string, device: string): Promise<CapturedBodyLookup> {
  try {
    return readCapturedBodyResult(await runHostAction("capture.body", { udid: device, id }));
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The body could not be loaded." };
  }
}
