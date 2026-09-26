import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { applyCaptureFields, captureFieldSet, type CaptureField } from "./fields";
import { redactHeaders } from "./redact";
import { clampBody, type CaptureStore } from "./store";

const PENDING_LIMIT = 1000;

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

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const limit = maxControlBodyBytes();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
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
}) {
  const flowIds = new Map<string, string>();
  const fields = captureFieldSet(options.fields);
  let announceReady = () => {};
  const ready = new Promise<void>((resolve) => {
    announceReady = resolve;
  });

  const server = createServer((req, res) => {
    const route = new URL(req.url ?? "/", "http://127.0.0.1");
    if (route.searchParams.get("t") !== options.token) return reply(res, 403);
    if (route.pathname === "/ready") {
      announceReady();
      return reply(res, 200, { ok: true });
    }

    void readJsonBody(req).then((payload) => {
      const record = (payload ?? {}) as FinishedRecord;
      if (record.id == null) return reply(res, 200, { ok: false });
      if (route.pathname === "/request") {
        while (flowIds.size >= PENDING_LIMIT) flowIds.delete(flowIds.keys().next().value!);
        flowIds.set(record.id, options.store.start(record.method ?? "GET", record.url ?? "", record.startedAt));
        return reply(res, 200, { ok: true });
      }
      if (route.pathname === "/response") {
        const storeId = flowIds.get(record.id);
        if (storeId == null) return reply(res, 200, { ok: false });
        flowIds.delete(record.id);
        finishRecord(options.store, storeId, record, fields);
        return reply(res, 200, { ok: true });
      }
      return reply(res, 404);
    }).catch((error) => {
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

  return { server, port: address.port, ready };
}
