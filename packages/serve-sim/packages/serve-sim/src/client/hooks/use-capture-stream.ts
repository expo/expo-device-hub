import { useCallback, useEffect, useState } from "react";

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
    setMeta(null);
    const stream = openHostEventStream(path);
    stream.onmessage = ({ data }) => {
      try {
        const event = JSON.parse(data) as CaptureEvent;
        setErrored(false);
        if (event.type === "meta") {
          setMeta(event.meta);
          return;
        }
        if (event.type === "cleared") {
          setRequests([]);
          return;
        }
        if (event.type !== "started" && event.type !== "finished") return;
        setRequests((prev) => {
          const next = [...prev];
          const at = next.findIndex((r) => r.id === event.request.id);
          if (at === -1) next.push(event.request);
          else next[at] = event.request;
          return next.length > MAX_REQUESTS ? next.slice(next.length - MAX_REQUESTS) : next;
        });
      } catch {
        // Ignore malformed frames.
      }
    };
    stream.onerror = () => setErrored(true);
    return () => stream.close();
  }, [path, streamKey]);

  return { meta, requests, errored, clear, setMeta };
}

// Request IDs are per device; always include the device in body lookups.
export async function fetchCapturedBody(
  id: string,
  device: string,
): Promise<CapturedBody | null> {
  try {
    const result = await runHostAction("capture.body", { udid: device, id });
    return result.exitCode === 0 && result.stdout
      ? JSON.parse(result.stdout) as CapturedBody
      : null;
  } catch {
    return null;
  }
}
