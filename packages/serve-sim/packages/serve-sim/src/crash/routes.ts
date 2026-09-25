import { booleanParam } from "../request-params";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ServeSimDeviceState } from "../state";
import { logBufferCache, type LogBufferCache } from "../log-buffer";
import { openSseStream } from "../sse-stream";
import { crashRuntime, isMissingFile, type CrashRuntime } from "./runtime";
import { parseCrashReport } from "./report";
import { MAX_OCCURRENCES, type CrashOccurrence } from "./store";
import { summarizeCrash, type CrashStreamFrame, type CrashDetailResponse } from "./protocol";

/** A reader keeps the tail alive, so a crash during this stream still has lines before it. */
function wantsTail(rawUrl: string): boolean {
  return booleanParam(new URL(rawUrl, "http://127.0.0.1").searchParams, "tail");
}

function holdDeviceTail(buffers: LogBufferCache, udid: string): () => void {
  return buffers.ensure(udid).subscribeBatch(() => {});
}

export async function handleCrashesRequestAfter(
  start: () => Promise<unknown>,
  req: IncomingMessage,
  res: ServerResponse,
  state: ServeSimDeviceState | null,
  rawUrl = "",
  runtime: CrashRuntime = crashRuntime,
  logBuffers: LogBufferCache = logBufferCache
): Promise<void> {
  const watching =
    (req.headers.accept ?? "").includes("text/event-stream") && wantsTail(rawUrl);
  const release = state && watching ? holdDeviceTail(logBuffers, state.device) : null;
  try {
    if (state) await start();
    handleCrashesRequest(req, res, state, rawUrl, runtime, logBuffers);
  } finally {
    release?.();
  }
}

export function handleCrashesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServeSimDeviceState | null,
  rawUrl = "",
  runtime: CrashRuntime = crashRuntime,
  logBuffers: LogBufferCache = logBufferCache
): void {
  if (!state) {
    res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "No serve-sim device" }));
    return;
  }
  const udid = state.device;
  const wantsStream = (req.headers.accept ?? "").includes("text/event-stream");
  if (wantsStream && (res.destroyed || req.destroyed)) return;
  if (!wantsStream) {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(
      JSON.stringify({ meta: runtime.meta(), crashes: runtime.listFor(udid).map(summarizeCrash) })
    );
    return;
  }

  let lastMeta = JSON.stringify(runtime.meta());
  const stream = openSseStream(req, res, {
    onHeartbeat: () => {
      const next = JSON.stringify(runtime.meta());
      if (next === lastMeta) return;
      lastMeta = next;
      stream.write(`data: {"type":"meta","meta":${next}}\n\n`);
    },
  });

  const { crashes, unsubscribe } = runtime.subscribe(
    udid,
    (event) => {
      const frame: CrashStreamFrame =
        event.type === "evicted" ? event : { type: event.type, record: summarizeCrash(event.record) };
      stream.write("data: " + JSON.stringify(frame) + "\n\n");
    },
    () => {
      if (stream.isOpen()) res.end();
    }
  );
  stream.onClose(unsubscribe);
  // Only a reader that is watching for new crashes pays for keeping the device tail alive.
  if (wantsTail(rawUrl)) {
    stream.onClose(holdDeviceTail(logBuffers, udid));
  }

  stream.write(`data: {"type":"meta","meta":${lastMeta}}\n\n`);
  stream.write(
    "data: " + JSON.stringify({ type: "list", crashes: crashes.map(summarizeCrash) }) + "\n\n"
  );
}

export async function handleCrashReportRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  state: ServeSimDeviceState | null,
  id: string,
  occurrenceParam: string | null = null,
  runtime: CrashRuntime = crashRuntime,
  readReport: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
  keyParam: string | null = null
): Promise<void> {
  const fail = (status: number, error: string): void => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error }));
  };

  if (!state) return fail(404, "No serve-sim device");
  const record = runtime.getFor(state.device, id);
  if (!record) {
    return fail(
      404,
      `No crash with id ${id} for device ${state.device}. Ids come from GET {base}/crashes for ` +
        "the same device, and the newest 20 signatures are kept, so a stale id can age out."
    );
  }

  const total = record.occurrences.length;
  const key = keyParam?.trim();
  const keyed = key
    ? record.occurrences.findIndex((occurrence) => String(occurrence.key) === key)
    : null;
  if (keyed === -1) {
    return fail(
      404,
      `Occurrence ${key} of crash ${id} is no longer kept: only the newest ${MAX_OCCURRENCES} ` +
        "repeats are retained. Omit key and occurrence for the newest."
    );
  }
  const wanted = occurrenceParam?.trim();
  const requested = keyed ?? (wanted ? Number(wanted) : total - 1);
  if (!Number.isInteger(requested) || requested < 0 || requested >= total) {
    return fail(
      400,
      `Occurrence must be 0-${total - 1} for this crash (oldest first); omit it for the newest.`
    );
  }
  const occurrence = record.occurrences[requested]!;

  const rawPath = occurrence.rawPath;
  const retiredPath = join(dirname(rawPath), "Retired", basename(rawPath));
  let report: string | null = null;
  let failure: unknown = null;
  let failedPath = rawPath;
  try {
    report = await readReport(rawPath);
  } catch (error) {
    failure = error;
    if (isMissingFile(error)) {
      try {
        report = await readReport(retiredPath);
        failure = null;
      } catch (retiredError) {
        if (!isMissingFile(retiredError)) {
          failure = retiredError;
          failedPath = retiredPath;
        }
      }
    }
  }
  const replaced = report !== null && !isSameReport(report, occurrence);
  if (replaced) report = null;
  const reportError = replaced
    ? "The file at this path no longer holds this crash's report: macOS replaced it, or it no longer parses. The summary and this occurrence's log tail are what is left."
    : failure === null
      ? null
      : isMissingFile(failure)
        ? "macOS has deleted this report, so the summary and this occurrence's log tail are what is left."
        : `Could not read ${failedPath} (${failure instanceof Error ? failure.message : String(failure)}). ` +
          `Check that serve-sim can read ${dirname(failedPath)}.`;

  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  const detail: CrashDetailResponse = {
    record: summarizeCrash(record),
    occurrence: { ...occurrence, index: requested, total },
    report,
    reportError,
  };
  res.end(JSON.stringify(detail));
}

function isSameReport(raw: string, occurrence: CrashOccurrence): boolean {
  const report = parseCrashReport(raw);
  if (report === null) return false;
  if (occurrence.incidentId !== null) return report.incidentId === occurrence.incidentId;
  return report.pid === occurrence.pid && report.capturedAt === occurrence.capturedAt;
}
