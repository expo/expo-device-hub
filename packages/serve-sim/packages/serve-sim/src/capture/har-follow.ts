import { basename, dirname } from "node:path";

import { CaptureDiskAccumulator } from "./disk";
import { parseFinishedCaptureRequest, type HarEntry } from "./har";
import type { CapturedBody } from "./store";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface FollowCaptureHarOptions {
  baseUrl: string;
  device: string;
  outPath: string;
  eventsPath?: string;
  flushIntervalMs?: number;
  signal?: AbortSignal;
  version?: string;
  fetchImpl?: FetchLike;
  /** Bearer token for capture routes (from serve-sim device state / preview). */
  token: string;
}

export interface FollowCaptureHarResult {
  size: number;
  harPath: string;
  eventsPath: string;
  entriesPath: string;
}

/** A recording's working files, named after its HAR so recordings can share a folder. */
export function captureHarPaths(harPath: string): { eventsPath: string; entriesPath: string; ownerFile: string } {
  const stem = harPath.replace(/\.har$/i, "");
  return {
    eventsPath: `${stem}.network-capture.json`,
    entriesPath: `${stem}.entries.ndjson`,
    ownerFile: `${basename(stem)}.owner.pid`,
  };
}

function captureRoute(baseUrl: string, path: string, device: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  url.searchParams.set("device", device);
  return url;
}

function captureUnavailable(data: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const event = parsed as { type?: string; meta?: { attachment?: string; attachError?: string | null } };
  if (event.type !== "meta") return null;
  if (event.meta?.attachment === "not-enabled") {
    return event.meta.attachError || "Network capture is not enabled on this device. Enable capture to record new requests.";
  }
  if (event.meta?.attachment === "failed") {
    return event.meta.attachError || "Network capture failed on this device.";
  }
  return null;
}

async function fetchBody(
  baseUrl: string,
  device: string,
  id: string,
  fetchImpl: FetchLike,
  token: string,
  signal?: AbortSignal,
): Promise<CapturedBody | null> {
  const withDevice = captureRoute(baseUrl, `/network-capture/${encodeURIComponent(id)}`, device);
  try {
    const res = await fetchImpl(withDevice, {
      signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.warn(`Network capture: body fetch HTTP ${res.status} for ${id}`);
      return null;
    }
    return (await res.json()) as CapturedBody;
  } catch (error) {
    console.warn(
      `Network capture: body fetch failed for ${id}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/** Bytes of seed entries recorded before waiting for the disk to catch up, so memory stays bounded. */
const SEED_WRITE_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * Copy the completed entries the session already recorded. The live stream replays only the
 * in-memory store (the newest 500 requests), so a follower started late seeds itself first. The
 * entry log is read line by line, so a large recording never has to fit in memory.
 */
async function seedFromSession(
  opts: FollowCaptureHarOptions,
  fetchImpl: FetchLike,
  disk: CaptureDiskAccumulator,
  seeded: Set<string>,
): Promise<void> {
  const url = captureRoute(opts.baseUrl, "/network-capture.ndjson", opts.device);
  let skipped = 0;
  try {
    const res = await fetchImpl(url, { signal: opts.signal, headers: { Authorization: `Bearer ${opts.token}` } });
    // 404: no session recording yet, or a server without the route. The live stream still applies.
    if (res.status === 404) return;
    if (!res.ok || !res.body) {
      console.warn(`Network capture: session entries fetch HTTP ${res.status}; earlier requests are omitted.`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let unsettled = 0;
    const record = async (line: string) => {
      if (!line.trim()) return;
      let entry: HarEntry;
      try {
        entry = JSON.parse(line) as HarEntry;
      } catch {
        skipped++;
        return;
      }
      disk.recordHarEntry(entry);
      if (entry._captureId) seeded.add(entry._captureId);
      unsettled += line.length;
      if (unsettled >= SEED_WRITE_BATCH_BYTES) {
        await disk.settled();
        unsettled = 0;
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) await record(line);
      }
      await record(buffer + decoder.decode());
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (isAbort(error)) throw error;
    console.warn(
      "Network capture: session entries fetch failed; earlier requests are omitted:",
      error instanceof Error ? error.message : error,
    );
  }
  if (skipped > 0) console.warn(`Network capture: skipped ${skipped} unreadable session entries.`);
}

/** Follow /network-capture SSE into the same NDJSON → streamed HAR layout as the live session. */
export async function followCaptureHar(opts: FollowCaptureHarOptions): Promise<FollowCaptureHarResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const paths = captureHarPaths(opts.outPath);
  const eventsPath = opts.eventsPath ?? paths.eventsPath;
  const version = opts.version ?? "0.0.0";
  const dir = dirname(opts.outPath);

  const disk = new CaptureDiskAccumulator({
    dir,
    harPath: opts.outPath,
    networkCapturePath: eventsPath,
    entriesPath: paths.entriesPath,
    ownerFile: paths.ownerFile,
    creatorVersion: version,
    flushIntervalMs: opts.flushIntervalMs ?? 5_000,
  });
  disk.begin();

  const streamUrl = captureRoute(opts.baseUrl, "/network-capture", opts.device).toString();

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let streamFailure: { error: unknown } | undefined;
  let flushFailure: Error | null = null;
  try {
    // Subscribe before seeding: the server holds live events for this subscriber while the seed is
    // read, so a request that finishes meanwhile is not lost. Replays of seeded requests are skipped.
    const res = await fetchImpl(streamUrl, {
      headers: {
        accept: "text/event-stream",
        Authorization: `Bearer ${opts.token}`,
      },
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`capture stream HTTP ${res.status}`);
    }
    reader = res.body.getReader();

    const seeded = new Set<string>();
    await seedFromSession(opts, fetchImpl, disk, seeded);
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        const unavailable = captureUnavailable(data);
        if (unavailable) throw new Error(unavailable);
        disk.recordEvent(data);
        const finished = parseFinishedCaptureRequest(data);
        if (!finished || seeded.has(finished.id)) continue;
        const body = await fetchBody(
          opts.baseUrl,
          opts.device,
          finished.id,
          fetchImpl,
          opts.token,
          opts.signal,
        );
        disk.recordFinished(finished, body);
      }
    }
  } catch (error) {
    streamFailure = { error };
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    flushFailure = await disk.end({ removeDir: false });
  }
  if (flushFailure) throw flushFailure;
  if (streamFailure) throw streamFailure.error;

  return {
    size: disk.size,
    harPath: disk.harPath,
    eventsPath: disk.networkCapturePath,
    entriesPath: disk.entriesPath,
  };
}
