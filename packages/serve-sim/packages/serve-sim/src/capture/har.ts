import type { CapturedBody, CapturedRequest } from "./store";

/** Soft ceiling for durable HAR / follow accumulators (live store stays at 500). */
export const MAX_HAR_ENTRIES = 10_000;

export interface HarHeader {
  name: string;
  value: string;
}

export interface HarCookie {
  name: string;
  value: string;
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: string;
}

export interface HarPostData {
  mimeType: string;
  text: string;
  params: [];
  _encoding?: "base64";
}

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  cookies: HarCookie[];
  headers: HarHeader[];
  queryString: { name: string; value: string }[];
  headersSize: number;
  bodySize: number;
  postData?: HarPostData;
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  cookies: HarCookie[];
  headers: HarHeader[];
  content: HarContent;
  redirectURL: string;
  headersSize: number;
  bodySize: number;
  _error?: string;
}

export interface HarTimings {
  blocked: number;
  dns: number;
  connect: number;
  ssl: number;
  send: number;
  wait: number;
  receive: number;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: HarTimings;
  _captureId?: string;
}

export interface HarLog {
  version: string;
  creator: { name: string; version: string };
  entries: HarEntry[];
}

export interface HarFile {
  log: HarLog;
}

const STATUS_TEXT: Record<number, string> = {
  0: "",
  100: "Continue",
  101: "Switching Protocols",
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  206: "Partial Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  418: "I'm a teapot",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

function headersFrom(record: Record<string, string> | undefined): HarHeader[] {
  if (!record) return [];
  return Object.entries(record).map(([name, value]) => ({ name, value }));
}

function headerValue(headers: HarHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** Absolute URL without fragment. */
export function harAbsoluteUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const hash = url.indexOf("#");
    return hash === -1 ? url : url.slice(0, hash);
  }
}

function queryStringFrom(url: string): { name: string; value: string }[] {
  try {
    const out: { name: string; value: string }[] = [];
    new URL(url).searchParams.forEach((value, name) => out.push({ name, value }));
    return out;
  } catch {
    return [];
  }
}

export function cookiesFromHeader(value: string | undefined, kind: "request" | "response"): HarCookie[] {
  if (!value) return [];
  if (kind === "request") {
    return value
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf("=");
        if (eq === -1) return { name: part, value: "" };
        return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
      })
      .filter((c) => c.name);
  }
  const first = value.split(";", 1)[0] ?? "";
  const eq = first.indexOf("=");
  if (eq === -1) return [];
  const name = first.slice(0, eq).trim();
  if (!name) return [];
  return [{ name, value: first.slice(eq + 1).trim() }];
}

function contentFrom(
  text: string | null | undefined,
  mimeType: string | null | undefined,
  size: number,
  binary: boolean | undefined,
  truncated: boolean | undefined,
): HarContent {
  const mime = mimeType || "application/octet-stream";
  if (text == null) return { size, mimeType: mime };
  const shown = binary ? Buffer.from(text, "base64").length : Buffer.byteLength(text, "utf8");
  return {
    size: truncated ? Math.max(size, shown) : shown,
    mimeType: mime,
    text,
    ...(binary ? { encoding: "base64" } : {}),
  };
}

/** send/wait/receive ≥ 0; time equals their sum. */
export function harTimings(request: CapturedRequest): { timings: HarTimings; time: number } {
  const duration = Math.max(0, request.durationMs ?? 0);
  const ttfb = request.ttfbMs;
  const send = 0;
  let wait = 0;
  let receive = 0;
  if (ttfb != null && request.durationMs != null) {
    wait = Math.max(0, Math.min(ttfb, duration));
    receive = Math.max(0, duration - wait);
  } else if (request.durationMs != null) {
    wait = duration;
  }
  const timings: HarTimings = {
    blocked: -1,
    dns: -1,
    connect: -1,
    ssl: -1,
    send,
    wait,
    receive,
  };
  return { timings, time: send + wait + receive };
}

function statusTextFor(status: number, failure: string | null): string {
  if (failure) return "Error";
  return STATUS_TEXT[status] ?? "";
}

/** An ISO start time; a malformed report falls back to now rather than failing the entry. */
function harStartedDateTime(startedAt: number): string {
  const started = new Date(startedAt);
  return Number.isNaN(started.getTime()) ? new Date().toISOString() : started.toISOString();
}

export function toHarEntry(
  request: CapturedRequest,
  body: CapturedBody | null = null,
): HarEntry {
  const { timings, time } = harTimings(request);
  const reqHeaders = headersFrom(body?.requestHeaders);
  const resHeaders = headersFrom(body?.responseHeaders);
  const absUrl = harAbsoluteUrl(request.url);
  const reqMime =
    request.requestMimeType ?? headerValue(reqHeaders, "content-type") ?? "application/octet-stream";
  const location = headerValue(resHeaders, "location") ?? "";
  const status = request.status ?? 0;

  const entry: HarEntry = {
    startedDateTime: harStartedDateTime(request.startedAt),
    time,
    request: {
      method: request.method,
      url: absUrl,
      httpVersion: "HTTP/1.1",
      cookies: cookiesFromHeader(headerValue(reqHeaders, "cookie"), "request"),
      headers: reqHeaders,
      queryString: queryStringFrom(absUrl),
      headersSize: -1,
      bodySize: request.requestBytes,
    },
    response: {
      status,
      statusText: statusTextFor(status, request.failure),
      httpVersion: "HTTP/1.1",
      cookies: cookiesFromHeader(headerValue(resHeaders, "set-cookie"), "response"),
      headers: resHeaders,
      content: contentFrom(
        body?.responseBody,
        request.mimeType ?? headerValue(resHeaders, "content-type"),
        request.responseBytes,
        body?.responseBinary,
        body?.responseTruncated,
      ),
      redirectURL: location,
      headersSize: -1,
      bodySize: request.responseBytes,
      ...(request.failure ? { _error: request.failure } : {}),
    },
    cache: {},
    timings,
    _captureId: request.id,
  };

  if (body?.requestBody) {
    entry.request.postData = {
      mimeType: reqMime,
      text: body.requestBody,
      params: [],
      ...(body.requestBinary ? { _encoding: "base64" } : {}),
    };
  }

  return entry;
}

export function emptyHar(creatorVersion = "0.0.0"): HarFile {
  return {
    log: {
      version: "1.2",
      creator: { name: "@expo/serve-sim", version: creatorVersion },
      entries: [],
    },
  };
}

export function isHarEntryCompliant(entry: HarEntry): boolean {
  const { timings, time } = entry;
  if (timings.send < 0 || timings.wait < 0 || timings.receive < 0) return false;
  // ssl is nested in connect for HAR 1.2 and must not be double-counted.
  const sum = (["blocked", "dns", "connect", "send", "wait", "receive"] as const)
    .map((k) => timings[k])
    .filter((n) => n >= 0)
    .reduce((a, b) => a + b, 0);
  if (sum !== time) return false;
  if (!entry.startedDateTime || Number.isNaN(Date.parse(entry.startedDateTime))) return false;
  if (entry.request.url.includes("#")) return false;
  return true;
}

export class HarAccumulator {
  private readonly entries = new Map<string, HarEntry>();

  constructor(
    private readonly creatorVersion = "0.0.0",
    private readonly maxEntries = MAX_HAR_ENTRIES,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  upsert(request: CapturedRequest, body: CapturedBody | null = null): void {
    this.entries.set(request.id, toHarEntry(request, body));
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  toHar(): HarFile {
    const har = emptyHar(this.creatorVersion);
    har.log.entries = [...this.entries.values()].sort((a, b) =>
      a.startedDateTime < b.startedDateTime ? -1 : a.startedDateTime > b.startedDateTime ? 1 : 0,
    );
    return har;
  }

  toJSON(pretty = false): string {
    return JSON.stringify(this.toHar(), null, pretty ? 2 : undefined);
  }
}

export function harFromStore(
  requests: CapturedRequest[],
  bodyFor: (id: string) => CapturedBody | null,
  creatorVersion = "0.0.0",
): HarFile {
  const acc = new HarAccumulator(creatorVersion);
  for (const request of requests) {
    acc.upsert(request, bodyFor(request.id));
  }
  return acc.toHar();
}

/** Parse an SSE data payload; returns the request only for finished frames. */
export function parseFinishedCaptureRequest(data: string): CapturedRequest | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.type !== "finished") return null;
  const request = parsed.request as CapturedRequest | undefined;
  return request?.id ? request : null;
}
