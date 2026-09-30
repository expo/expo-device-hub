import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { applyCaptureFields, captureFieldSet, type CaptureField } from "./fields";
import { redactHeaders } from "./redact";
import { safeEqualString } from "../session-auth";
import { clampBody, type CaptureStore } from "./store";

const PENDING_LIMIT = 1000;
/** The header the addon sends its control token in. */
export const CONTROL_TOKEN_HEADER = "x-serve-sim-capture-token";

export const DEFAULT_MAX_CONTROL_BODY_BYTES = 10 * 1024 * 1024;
export const MAX_CONTROL_BODY_BYTES_ENV = "SERVE_SIM_CAPTURE_MAX_CONTROL_BODY_BYTES";

export interface OversizedControlBodyInfo {
  bytesSeen: number;
  limit: number;
  path: string;
}

interface RecordPart {
  mime?: string | null;
  headers?: Record<string, string>;
  size?: number;
  body?: string | null;
  base64?: string | null;
  truncated?: boolean;
}

interface FinishedRecord {
  id?: string;
  method?: string;
  startedAt?: number;
  url?: string;
  status?: number | null;
  ttfbMs?: number | null;
  durationMs?: number | null;
  error?: string | null;
  req?: RecordPart;
  res?: RecordPart;
}

class ControlBodyTooLargeError extends Error {
  constructor(
    readonly bytesSeen: number,
    readonly limit: number,
  ) {
    super(`control body too large (${bytesSeen} > ${limit})`);
  }
}

export function maxControlBodyBytes(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
  const value = Number(env[MAX_CONTROL_BODY_BYTES_ENV]?.trim());
  return Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : DEFAULT_MAX_CONTROL_BODY_BYTES;
}

export function formatOversizedControlBodyWarning(info: OversizedControlBodyInfo): string {
  return (
    `[capture] Dropped oversized control body on ${info.path} ` +
    `(${info.bytesSeen} > ${info.limit} bytes). Raise ${MAX_CONTROL_BODY_BYTES_ENV} to allow larger posts.`
  );
}

/** How long a control post may take to arrive; the addon sends each record in one quick post. */
const CONTROL_BODY_TIMEOUT_MS = 30_000;

class ControlBodyTimeoutError extends Error {}

function readJsonBody(req: IncomingMessage, timeoutMs = CONTROL_BODY_TIMEOUT_MS): Promise<unknown> {
  const limit = maxControlBodyBytes();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    // A client that stalls mid-post would otherwise hold the connection and its buffered chunks.
    // A plain timer, since Bun's IncomingMessage does not fire setTimeout.
    const timer = setTimeout(() => {
      if (rejected) return;
      rejected = true;
      chunks.length = 0;
      reject(new ControlBodyTimeoutError(`The control post did not finish within ${timeoutMs}ms.`));
      req.destroy();
      req.socket?.destroy();
    }, timeoutMs);
    timer.unref?.();
    const settle = () => clearTimeout(timer);
    req.once("end", settle);
    req.once("error", settle);
    req.once("close", settle);
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      rejected = true;
      reject(new ControlBodyTooLargeError(size, limit));
    });
    req.on("error", reject);
    req.on("end", () => {
      if (rejected) return;
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function bodyText(part: RecordPart | undefined) {
  if (part?.body != null) {
    return { ...clampBody([Buffer.from(part.body)]), binary: false };
  }
  if (part?.base64 != null) {
    return { text: part.base64, truncated: part.truncated ?? false, binary: true };
  }
  return { text: null, truncated: false, binary: false };
}

export function describeFailure(raw: string): string {
  if (/Errno 61|Connect call failed|refused/i.test(raw)) {
    return `Nothing was listening at the address the app connected to. (${raw})`;
  }
  if (/Errno 8|nodename nor servname|Name or service not known|getaddrinfo/i.test(raw)) {
    return `The host could not be resolved. (${raw})`;
  }
  if (/certificate|CERTIFICATE_VERIFY|SSL|TLS/i.test(raw)) {
    return (
      "The TLS connection failed. Check the server certificate and simulator trust; apps with certificate " +
      `pinning may reject the capture proxy. (${raw})`
    );
  }
  if (/timed out|ETIMEDOUT|Errno 60/i.test(raw)) {
    return `The host accepted the connection but never replied. (${raw})`;
  }
  return raw;
}

function finishRecord(
  store: CaptureStore,
  storeId: string,
  record: FinishedRecord,
  fields: ReadonlySet<CaptureField>,
): void {
  const request = bodyText(record.req);
  const response = bodyText(record.res);
  const requestBytes = record.req?.size ?? 0;
  const responseBytes = record.res?.size ?? 0;

  store.setBody(storeId, applyCaptureFields({
    requestHeaders: redactHeaders(record.req?.headers ?? {}),
    responseHeaders: redactHeaders(record.res?.headers ?? {}),
    requestBody: request.text,
    responseBody: response.text,
    requestTruncated: request.truncated || (record.req?.truncated ?? false),
    responseTruncated: response.truncated || (record.res?.truncated ?? false),
    requestBinary: request.binary,
    responseBinary: response.binary,
  }, fields));
  store.noteTraffic(responseBytes, requestBytes, record.durationMs ?? 0);
  store.update(storeId, {
    status: record.status ?? null,
    mimeType: record.res?.mime ?? record.res?.headers?.["content-type"] ?? null,
    requestMimeType: record.req?.mime ?? record.req?.headers?.["content-type"] ?? null,
    requestBytes,
    responseBytes,
    ttfbMs: record.ttfbMs ?? null,
    durationMs: record.durationMs ?? null,
    failure: record.error ? describeFailure(record.error) : null,
  }, /* settled */ true);
}

function reply(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startMitmControl(options: {
  store: CaptureStore;
  token: string;
  fields: readonly CaptureField[];
  onOversizedBody?: (info: OversizedControlBodyInfo) => void;
  /** How long a post may take to arrive; replaceable in tests. */
  bodyTimeoutMs?: number;
}) {
  const flowIds = new Map<string, string>();
  // The store keeps only the newest rows. A request evicted while still in flight has no row for its
  // response; its mapping goes with it, and the response is counted and reported once, not dropped
  // silently.
  const flowOfRow = new Map<string, string>();
  const evictedFlows = new Set<string>();
  // Requests the user cleared while they were in flight; their responses are acknowledged and let go.
  const clearedFlows = new Set<string>();
  let lateResponses = 0;
  const forget = (set: Set<string>, flow: string) => {
    set.add(flow);
    while (set.size > PENDING_LIMIT) set.delete(set.values().next().value!);
  };
  const unsubscribe = options.store.subscribe((event) => {
    if (event.type === "cleared") {
      for (const flow of flowIds.keys()) forget(clearedFlows, flow);
      flowIds.clear();
      flowOfRow.clear();
      return;
    }
    if (event.type !== "evicted") return;
    const flow = flowOfRow.get(event.id);
    if (flow === undefined) return;
    flowOfRow.delete(event.id);
    flowIds.delete(flow);
    forget(evictedFlows, flow);
  });
  const fields = captureFieldSet(options.fields);
  let announceReady = () => {};
  const ready = new Promise<void>((resolve) => {
    announceReady = resolve;
  });

  const server = createServer((req, res) => {
    const route = new URL(req.url ?? "/", "http://127.0.0.1");
    // The token is a header; a URL could end up in logs and diagnostics.
    const token = req.headers[CONTROL_TOKEN_HEADER];
    if (typeof token !== "string" || !safeEqualString(token, options.token)) return reply(res, 403);
    if (route.pathname === "/ready") {
      announceReady();
      return reply(res, 200, { ok: true });
    }

    void readJsonBody(req, options.bodyTimeoutMs).then((payload) => {
      const record = (payload ?? {}) as FinishedRecord;
      if (record.id == null) return reply(res, 200, { ok: false });
      if (route.pathname === "/request") {
        while (flowIds.size >= PENDING_LIMIT) {
          const [oldFlow, oldRow] = flowIds.entries().next().value!;
          flowIds.delete(oldFlow);
          flowOfRow.delete(oldRow);
        }
        const row = options.store.start(record.method ?? "GET", record.url ?? "", record.startedAt);
        flowIds.set(record.id, row);
        flowOfRow.set(row, record.id);
        return reply(res, 200, { ok: true });
      }
      if (route.pathname === "/response") {
        const storeId = flowIds.get(record.id);
        if (storeId == null) {
          // Cleared on purpose, so not a loss: nothing to record and nothing to report.
          if (clearedFlows.delete(record.id)) return reply(res, 200, { ok: true, cleared: true });
          if (evictedFlows.delete(record.id)) {
            // Delivered, so the addon does not count it lost; its row had already left the list.
            lateResponses += 1;
            if (lateResponses === 1) {
              console.warn(
                "Network capture: a request left the 500-row list before its response arrived, so the " +
                  "response was not recorded. Clear the list or reduce traffic to keep slow requests.",
              );
            }
            return reply(res, 200, { ok: true, evicted: true });
          }
          return reply(res, 200, { ok: false });
        }
        flowIds.delete(record.id);
        flowOfRow.delete(storeId);
        finishRecord(options.store, storeId, record, fields);
        return reply(res, 200, { ok: true });
      }
      return reply(res, 404);
    }).catch((error) => {
      // A stalled post's socket is already destroyed; there is nobody to answer.
      if (error instanceof ControlBodyTimeoutError) return;
      if (!(error instanceof ControlBodyTooLargeError)) return reply(res, 400);
      const info = { bytesSeen: error.bytesSeen, limit: error.limit, path: route.pathname };
      console.warn(formatOversizedControlBodyWarning(info));
      options.onOversizedBody?.(info);
      reply(res, 413);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.on("error", () => {});
  const address = server.address();
  if (address == null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Could not start the capture control server on a local port.");
  }

  server.on("close", unsubscribe);
  return {
    server,
    port: address.port,
    ready,
    /** Responses whose request had already left the store's list. */
    lateResponses: () => lateResponses,
  };
}
