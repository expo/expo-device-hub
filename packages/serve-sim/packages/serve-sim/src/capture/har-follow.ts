import { randomUUID } from "node:crypto";
import { closeSync, constants, createReadStream, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { claimCaptureDirectory, releaseCaptureDirectory } from "./artifact-owner";
import { CaptureDiskAccumulator } from "./disk";
import { harStartedDateTime, parseFinishedCaptureRequest, type HarEntry } from "./har";
import { OWNER_ONLY_FILE, writeAllAsync } from "./no-follow";
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
  /** Replace a recording that already has requests at `outPath` (the CLI's `--force`). */
  replace?: boolean;
  /** Called once the recording has begun at `outPath`, on the first frame that shows capture is on. */
  onBegin?: () => void;
  /** Called when capture goes off after the recording began; recording resumes when it comes back. */
  onPause?: (reason: string) => void;
  /** Called when capture is on again after a pause. */
  onResume?: () => void;
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
  startedAt: number,
  fetchImpl: FetchLike,
  token: string,
  signal?: AbortSignal,
): Promise<CapturedBody | null> {
  // The server answers 404 if its request with this id is a newer session's. A start time that is not
  // a number (sent as null) cannot be matched, and an id alone could name a newer session's request,
  // so such an entry is kept without its body.
  if (!Number.isFinite(startedAt)) return null;
  const withDevice = captureRoute(baseUrl, `/network-capture/${encodeURIComponent(id)}`, device);
  withDevice.searchParams.set("startedAt", String(startedAt));
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

/** Whether a frame is the meta frame that shows the proxy is up and requests are being recorded. */
function isCapturingMeta(data: string): boolean {
  try {
    const event = JSON.parse(data) as { type?: string; meta?: { attachment?: string } };
    return event.type === "meta" && event.meta?.attachment === "capturing";
  } catch {
    return false;
  }
}

/**
 * A request's identity across sessions. Ids restart at r1 in every capture session, so an id alone
 * would match an earlier session's request; the start time tells them apart.
 */
function requestKey(id: string, startedAt: number | null | undefined): string {
  return `${id} ${Number.isFinite(startedAt) ? startedAt : "none"}`;
}

/**
 * Open the completed entries the session already recorded. The live stream replays only the
 * in-memory store (the newest 500 requests), so a follower started late seeds itself first.
 */
async function openSessionSeed(opts: FollowCaptureHarOptions, fetchImpl: FetchLike): Promise<ReadableStream<Uint8Array> | null> {
  const url = captureRoute(opts.baseUrl, "/network-capture.ndjson", opts.device);
  const res = await fetchImpl(url, { signal: opts.signal, headers: { Authorization: `Bearer ${opts.token}` } });
  // 404: no session recording yet, or a server without the route. The live stream still applies.
  if (res.status === 404) return null;
  if (!res.ok || !res.body) {
    throw new Error(`Could not read the session's earlier requests (HTTP ${res.status}), so the recording would miss them.`);
  }
  return res.body;
}

/**
 * Download the whole seed to an owner-only file beside the recording before the recording begins,
 * so a seed that breaks off or holds an unreadable entry fails the run and leaves `--out` as it was:
 * a recording without its earlier requests would read as complete. Lines are streamed, so a large
 * recording never has to fit in memory.
 */
async function stageSessionSeed(body: ReadableStream<Uint8Array>, stagePath: string): Promise<void> {
  const handle = await open(
    stagePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    OWNER_ONLY_FILE,
  );
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const stage = async (line: string) => {
    if (!line.trim()) return;
    try {
      JSON.parse(line);
    } catch {
      throw new Error("The session's earlier requests include an unreadable entry, so the recording would miss it.");
    }
    await writeAllAsync(handle, `${line}\n`);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) await stage(line);
    }
    await stage(buffer + decoder.decode());
  } finally {
    // Under Bun, releasing a finished fetch body can throw; the stream is not reused either way.
    try { reader.releaseLock(); } catch {}
    await handle.close();
  }
}

/** The identities of the staged seed's entries, so their replays on the live stream are skipped. */
async function seededKeys(stagePath: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const lines = createInterface({ input: createReadStream(stagePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as HarEntry;
    if (!entry._captureId) continue;
    // Entries from a server without `_captureStartedAt` are matched by their HAR date instead.
    keys.add(
      entry._captureStartedAt !== undefined
        ? requestKey(entry._captureId, entry._captureStartedAt)
        : `${entry._captureId} ${entry.startedDateTime}`,
    );
  }
  return keys;
}

/** Whether two paths name the same file. macOS and Windows file systems ignore case by default. */
function samePath(a: string, b: string): boolean {
  const caseless = process.platform === "darwin" || process.platform === "win32";
  return caseless ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
}

/** Whether a file is missing, empty, or starts like an event log: a JSON frame with a `type`. */
function isEventLogOrEmpty(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return true;
  }
  try {
    const buffer = Buffer.alloc(HAR_SCAN_CHUNK_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    if (read === 0) return true;
    const text = buffer.subarray(0, read).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline === -1) return false;
    const frame = JSON.parse(text.slice(0, newline)) as { type?: unknown } | null;
    return typeof frame === "object" && frame !== null && typeof frame.type === "string";
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** Whether a file holds requests worth keeping: a HAR with entries, or a non-empty entry log. */
function holdsRequests(path: string, har: boolean): boolean {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return false;
  }
  if (size === 0 || !har) return size > 0;
  // Not a HAR this command wrote, or one it cannot read; keep it rather than guess.
  return harHasEntries(path) !== false;
}

const HAR_SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * Whether a HAR's `log.entries` holds an entry: true or false once the scan reaches that array, null
 * if the file ends first or is not a JSON object. The file is streamed through a small JSON state
 * machine that keeps only the key path, never values, so a HAR of any size is checked in constant
 * memory. An `entries` key elsewhere in the file, or text inside a string, does not count.
 */
export function harHasEntries(path: string): boolean | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  // One frame per open object or array; `key` is an object's current key once its colon is read.
  const stack: { object: boolean; key: string | null; expectKey: boolean }[] = [];
  let inString = false;
  let escaped = false;
  let collecting = false;
  let text = "";
  let lastKey: string | null = null;
  let inEntries = false;
  const buffer = Buffer.alloc(HAR_SCAN_CHUNK_BYTES);
  const decoder = new TextDecoder();
  try {
    while (true) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) return null;
      for (const c of decoder.decode(buffer.subarray(0, read), { stream: true })) {
        if (inString) {
          if (escaped) {
            escaped = false;
            // A key with an escape never matches "log" or "entries", so the scan stays conservative.
            if (collecting) text += "\u0000";
          } else if (c === "\\") {
            escaped = true;
          } else if (c === '"') {
            inString = false;
            if (collecting) lastKey = text;
          } else if (collecting && text.length < 16) {
            text += c;
          }
          continue;
        }
        if (c === " " || c === "\n" || c === "\r" || c === "\t") continue;
        if (inEntries) return c !== "]";
        const top = stack.at(-1);
        if (!top && c !== "{") return null;
        if (c === '"') {
          inString = true;
          collecting = !!top?.object && top.expectKey;
          text = "";
        } else if (c === ":") {
          if (top?.object) {
            top.key = lastKey;
            top.expectKey = false;
          }
        } else if (c === ",") {
          if (top?.object) {
            top.key = null;
            top.expectKey = true;
          }
        } else if (c === "{" || c === "[") {
          if (c === "[" && stack.length === 2 && stack[0]!.key === "log" && top?.object && top.key === "entries") {
            inEntries = true;
          }
          stack.push({ object: c === "{", key: null, expectKey: c === "{" });
        } else if (c === "}" || c === "]") {
          stack.pop();
          if (stack.length === 0) return null;
        }
      }
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export class ExistingRecordingError extends Error {
  constructor(readonly path: string) {
    super(
      `${path} already holds a recording, and starting again would replace it. Use a new --out path, ` +
        "or pass --force to replace it.",
    );
  }
}

export async function followCaptureHar(opts: FollowCaptureHarOptions): Promise<FollowCaptureHarResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const paths = captureHarPaths(opts.outPath);
  const eventsPath = opts.eventsPath ?? paths.eventsPath;
  // The recording's files are written independently; two sharing a path would corrupt each other.
  const named = [
    ["--out", opts.outPath],
    ["--events", eventsPath],
    ["the entry log", paths.entriesPath],
    ["the owner file", join(dirname(opts.outPath), paths.ownerFile)],
  ] as const;
  for (const [index, [label, path]] of named.entries()) {
    const clash = named.slice(0, index).find(([, other]) => samePath(other, path));
    if (clash) throw new Error(`${label} and ${clash[0]} name the same file (${resolve(path)}). Choose different paths.`);
  }
  // A recording that stopped (capture turned off, serve-sim restarted) is often rerun with the same
  // --out; replacing it would lose the requests it holds, and the session's own copy may be gone.
  // The event log is not checked for requests: every run writes its first meta frame there, requests
  // or not. It is only checked below to be an event log.
  if (!opts.replace) {
    const kept = [
      { path: opts.outPath, har: true },
      { path: paths.entriesPath, har: false },
    ].find(({ path, har }) => holdsRequests(path, har));
    if (kept) throw new ExistingRecordingError(kept.path);
    // The event log is replaced too. One from an earlier run may be replaced, but `--events` could
    // name any file, such as another recording's HAR.
    if (!isEventLogOrEmpty(eventsPath)) {
      throw new Error(
        `${eventsPath} is not a capture event log, and recording would replace it. Choose another --events ` +
          "path, or pass --force to replace it.",
      );
    }
  }
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
  const streamUrl = captureRoute(opts.baseUrl, "/network-capture", opts.device).toString();

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let streamFailure: { error: unknown } | undefined;
  let flushFailure: Error | null = null;
  // Set once the recording has begun. Nothing at --out is replaced before a meta frame shows capture
  // is on (`capturing`, not `starting`), so a refused connection, a device with capture off, or a
  // start that fails leaves an existing recording as it was.
  let seeded: Set<string> | null = null;
  let seedPath: string | null = null;
  let eventsClaim: { dir: string; file: string; owner: string } | null = null;
  let paused = false;
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
        // Before the recording began, capture being off or failed ends the run with --out untouched.
        if (unavailable && !seeded) throw new Error(unavailable);
        if (!seeded) {
          if (!isCapturingMeta(data)) continue;
          const seed = await openSessionSeed(opts, fetchImpl);
          if (seed) {
            // begin() would create the folder; the seed is staged in it first.
            mkdirSync(dirname(opts.outPath), { recursive: true, mode: 0o700 });
            // Named like the entry log's other temp files, so one a killed run leaves is removed.
            seedPath = `${paths.entriesPath}.${randomUUID()}.seed.tmp`;
            await stageSessionSeed(seed, seedPath);
          }
          // The HAR's claim covers its own files; a custom --events can name any path, so the event log
          // is claimed too, and a second live recording cannot replace it under the first.
          // Its own suffix: a HAR's owner file always ends in `.owner.pid`, so the two never coincide.
          eventsClaim = { dir: dirname(eventsPath), file: `${basename(eventsPath)}.events-claim.pid`, owner: "" };
          eventsClaim.owner = claimCaptureDirectory(eventsClaim.dir, eventsClaim.file);
          if (seedPath) {
            const keys = await seededKeys(seedPath);
            // The seed becomes the entry log; nothing at --out changes until the replacement is built.
            await disk.beginFrom(seedPath);
            seeded = keys;
          } else {
            disk.begin();
            seeded = new Set<string>();
          }
          opts.onBegin?.();
        }
        disk.recordEvent(data);
        // After it began, the recording follows the device through capture going off and on again
        // (a disable, a reboot with capture, a restart after a failure) and appends the new session.
        if (unavailable && !paused) {
          paused = true;
          opts.onPause?.(unavailable);
        } else if (paused && isCapturingMeta(data)) {
          paused = false;
          opts.onResume?.();
        }
        const finished = parseFinishedCaptureRequest(data);
        if (
          !finished
          || seeded.has(requestKey(finished.id, finished.startedAt))
          || seeded.has(`${finished.id} ${harStartedDateTime(finished.startedAt)}`)
        ) continue;
        const body = await fetchBody(
          opts.baseUrl,
          opts.device,
          finished.id,
          finished.startedAt,
          fetchImpl,
          opts.token,
          opts.signal,
        );
        disk.recordFinished(finished, body);
      }
    }
    if (!seeded) throw new Error("The capture stream closed before capture was on, so nothing was recorded.");
  } catch (error) {
    streamFailure = { error };
  } finally {
    await reader?.cancel().catch(() => {});
    try { reader?.releaseLock(); } catch {}
    if (seedPath) await unlink(seedPath).catch(() => {});
    flushFailure = await disk.end({ removeDir: false });
    if (eventsClaim?.owner) {
      try {
        releaseCaptureDirectory(eventsClaim.dir, eventsClaim.owner, false, eventsClaim.file);
      } catch {}
    }
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
