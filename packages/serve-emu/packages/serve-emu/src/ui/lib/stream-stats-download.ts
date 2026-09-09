export const STREAM_STATS_SCHEMA_VERSION = 1 as const;
export const STREAM_STATS_REDACTED = "[redacted]" as const;

const STREAM_STATS_TRUNCATED = "[truncated]" as const;
const MAX_SERVER_STRING_LENGTH = 8_192;
const MAX_SERVER_OBJECT_KEYS = 256;
const MAX_SERVER_ARRAY_ITEMS = 256;
const MAX_SERVER_DEPTH = 16;
const MAX_STATUS_LENGTH = 256;
const MAX_CODEC_LENGTH = 128;
const MAX_FPS = 1_000;
const MAX_DECODE_QUEUE = 1_000_000;
const MAX_LATENCY_MS = 3_600_000;
const MAX_DEVICE_DIMENSION = 16_384;
const MAX_SERVER_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;

export type StreamStatsTransport = "websocket" | "webrtc";
export type StreamStatsJsonValue =
  | null
  | boolean
  | number
  | string
  | StreamStatsJsonValue[]
  | { [key: string]: StreamStatsJsonValue };

export type StreamStatsDownloadViewerState = Readonly<{
  status?: unknown;
  generation?: unknown;
  lastRenderedAt?: unknown;
  fps?: unknown;
  deviceSize?: unknown;
  stats?: unknown;
}>;

export type StreamStatsViewerSnapshot = {
  transport: StreamStatsTransport;
  status: string | null;
  generation: number | null;
  lastRenderedAt: number | null;
  fps: number | null;
  deviceSize: { width: number; height: number } | null;
  stats: {
    fps: number | null;
    decodeQueue: number | null;
    transitMs: number | null;
    e2eMs: number | null;
    codec: string | null;
    rendered: boolean | null;
  } | null;
};

export type StreamStatsDownloadError = {
  source: "health" | "webrtc";
  message: string;
};

export type StreamStatsDocument = {
  schemaVersion: typeof STREAM_STATS_SCHEMA_VERSION;
  sampledAt: string;
  viewer: StreamStatsViewerSnapshot;
  server: {
    health: StreamStatsJsonValue;
    webrtc: StreamStatsJsonValue;
  };
  errors: StreamStatsDownloadError[];
};

export type StreamStatsDownloadInput = {
  transport: StreamStatsTransport;
  viewerState: StreamStatsDownloadViewerState;
  webRtcSessionId: string | null;
};

export type StreamStatsDownloadFile = {
  filename: string;
  blob: Blob;
};

export type StreamStatsFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type StreamStatsClock = {
  now(): number;
};

export type StreamStatsDownloadAdapter = (
  file: StreamStatsDownloadFile,
) => void | Promise<void>;

export type StreamStatsDownloadDependencies = {
  fetch?: StreamStatsFetch;
  clock?: StreamStatsClock;
  download?: StreamStatsDownloadAdapter;
  requestTimeoutMs?: number;
};

export type StreamStatsDownloadResult = StreamStatsDownloadFile & {
  document: StreamStatsDocument;
};

export type StreamStatsDownloadAnchor = {
  href: string;
  download: string;
  hidden: boolean;
  click(): void;
  remove(): void;
};

export type StreamStatsBrowserDownloadEnvironment = {
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  createAnchor(): StreamStatsDownloadAnchor;
  appendAnchor(anchor: StreamStatsDownloadAnchor): void;
};

type SanitizeContext = {
  depth: number;
  iceCandidateContext: boolean;
  ancestors: WeakSet<object>;
};

class StreamStatsResponseTooLargeError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isCredentialKey(key: string, iceCandidateContext: boolean): boolean {
  const normalized = normalizedKey(key);
  if (
    normalized.includes("token") ||
    normalized.includes("cookie") ||
    normalized.includes("authorization") ||
    normalized === "auth" ||
    normalized === "authheader" ||
    normalized === "authentication" ||
    normalized === "apikey" ||
    normalized === "accesskey" ||
    normalized.includes("credential") ||
    normalized.includes("password") ||
    normalized.includes("passwd") ||
    normalized.includes("secret") ||
    normalized.includes("sdp") ||
    normalized === "turnusername"
  ) {
    return true;
  }
  if (normalized === "candidate") return true;
  if (
    normalized.includes("candidate") &&
    (normalized.includes("url") ||
      normalized.includes("address") ||
      normalized.endsWith("ip"))
  ) {
    return true;
  }
  if (
    normalized.includes("ice") &&
    (normalized.includes("url") || normalized.includes("address"))
  ) {
    return true;
  }
  return iceCandidateContext &&
    (normalized === "url" ||
      normalized === "urls" ||
      normalized === "address" ||
      normalized === "ip" ||
      normalized === "ipaddress" ||
      normalized === "username");
}

function startsIceCandidateContext(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized.includes("ice") || normalized.includes("candidate");
}

function isSensitiveString(value: string, iceCandidateContext: boolean): boolean {
  const trimmed = value.trim();
  if (/\bbearer\s+[a-z0-9._~+/=-]{4,}/i.test(trimmed)) return true;
  if (/^basic\s+[a-z0-9+/=]{8,}$/i.test(trimmed)) return true;
  if (/\bauthorization\s*:?\s*(?:bearer|basic)\s+\S+/i.test(trimmed)) {
    return true;
  }
  if (
    /(?:^|[^a-z0-9])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|token|cookie|authorization|credential|password|passwd|secret)\s*[:=]/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(trimmed)) {
    return true;
  }
  if (/(?:^|[^a-z0-9])(?:stun|stuns|turn|turns):[^\s,;"']+/i.test(trimmed)) {
    return true;
  }
  if (/(?:^|[\s"'(])(?:a=)?candidate:/i.test(trimmed)) {
    return true;
  }
  if (/^v=0(?:\r?\n)/.test(trimmed) && /(?:^|\r?\n)m=/m.test(trimmed)) {
    return true;
  }
  const containsNetworkAddress =
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(trimmed) ||
    /(?:^|[^a-f0-9])(?:[a-f0-9]{0,4}:){2,}[a-f0-9]{0,4}(?:$|[^a-f0-9])/i.test(
      trimmed,
    );
  if (
    containsNetworkAddress &&
    (iceCandidateContext || /\b(?:ice|candidate)\b/i.test(trimmed))
  ) {
    return true;
  }
  return false;
}

function sanitizeString(value: string, iceCandidateContext: boolean): string {
  if (isSensitiveString(value, iceCandidateContext)) {
    return STREAM_STATS_REDACTED;
  }
  return value.length <= MAX_SERVER_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_SERVER_STRING_LENGTH - 1)}…`;
}

function sanitizeValue(
  value: unknown,
  context: SanitizeContext,
): StreamStatsJsonValue {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    return sanitizeString(value, context.iceCandidateContext);
  }
  if (typeof value !== "object") return null;
  if (context.depth >= MAX_SERVER_DEPTH) return STREAM_STATS_TRUNCATED;
  if (context.ancestors.has(value)) return STREAM_STATS_TRUNCATED;

  context.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_SERVER_ARRAY_ITEMS)
        .map((item) =>
          sanitizeValue(item, {
            ...context,
            depth: context.depth + 1,
          })
        );
    }

    const entries = Object.entries(value).slice(0, MAX_SERVER_OBJECT_KEYS);
    return Object.fromEntries(
      entries.map(([key, item]) => {
        const outputKey = key.length <= 256 ? key : key.slice(0, 256);
        const nextIceContext =
          context.iceCandidateContext || startsIceCandidateContext(key);
        return [
          outputKey,
          isCredentialKey(key, context.iceCandidateContext)
            ? STREAM_STATS_REDACTED
            : sanitizeValue(item, {
                depth: context.depth + 1,
                iceCandidateContext: nextIceContext,
                ancestors: context.ancestors,
              }),
        ];
      }),
    );
  } finally {
    context.ancestors.delete(value);
  }
}

/** Return a JSON-safe, bounded copy with credentials and network candidates removed. */
export function sanitizeStreamStatsValue(value: unknown): StreamStatsJsonValue {
  return sanitizeValue(value, {
    depth: 0,
    iceCandidateContext: false,
    ancestors: new WeakSet(),
  });
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  integer = false,
): number | null {
  return typeof value === "number" &&
      Number.isFinite(value) &&
      value >= minimum &&
      value <= maximum &&
      (!integer || Number.isInteger(value))
    ? value
    : null;
}

function boundedViewerString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const sanitized = sanitizeString(value, false);
  return sanitized.length <= maximum
    ? sanitized
    : `${sanitized.slice(0, maximum - 1)}…`;
}

/** Select only known local metrics so arbitrary viewer state never enters an export. */
export function buildStreamStatsViewerSnapshot(
  transport: StreamStatsTransport,
  viewerState: StreamStatsDownloadViewerState,
): StreamStatsViewerSnapshot {
  const deviceSize = isRecord(viewerState.deviceSize)
    ? {
        width: boundedNumber(
          viewerState.deviceSize.width,
          1,
          MAX_DEVICE_DIMENSION,
          true,
        ),
        height: boundedNumber(
          viewerState.deviceSize.height,
          1,
          MAX_DEVICE_DIMENSION,
          true,
        ),
      }
    : null;
  const stats = isRecord(viewerState.stats) ? viewerState.stats : null;

  return {
    transport,
    status: boundedViewerString(viewerState.status, MAX_STATUS_LENGTH),
    generation: boundedNumber(
      viewerState.generation,
      0,
      Number.MAX_SAFE_INTEGER,
      true,
    ),
    lastRenderedAt: boundedNumber(
      viewerState.lastRenderedAt,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    fps: boundedNumber(viewerState.fps, 0, MAX_FPS),
    deviceSize:
      deviceSize !== null &&
        deviceSize.width !== null &&
        deviceSize.height !== null
        ? { width: deviceSize.width, height: deviceSize.height }
        : null,
    stats: stats
      ? {
          fps: boundedNumber(stats.fps, 0, MAX_FPS),
          decodeQueue: boundedNumber(
            stats.decodeQueue,
            0,
            MAX_DECODE_QUEUE,
            true,
          ),
          transitMs: boundedNumber(stats.transitMs, 0, MAX_LATENCY_MS),
          e2eMs: boundedNumber(stats.e2eMs, 0, MAX_LATENCY_MS),
          codec: boundedViewerString(stats.codec, MAX_CODEC_LENGTH),
          rendered: typeof stats.rendered === "boolean" ? stats.rendered : null,
        }
      : null,
  };
}

function safeFilenameSegment(value: string | null): string {
  if (!value || isSensitiveString(value, false)) return "unknown-device";
  const normalized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return normalized || "unknown-device";
}

export function streamStatsDownloadFilename(
  serial: string | null,
  transport: StreamStatsTransport,
  sampledAt: string,
): string {
  const timestamp = sampledAt.replace(/[:.]/g, "-");
  return `serve-emu-${safeFilenameSegment(serial)}-${transport}-${timestamp}.json`;
}

export function streamStatsDocumentBlob(document: StreamStatsDocument): Blob {
  return new Blob([`${JSON.stringify(document, null, 2)}\n`], {
    type: "application/json",
  });
}

function defaultBrowserDownloadEnvironment(): StreamStatsBrowserDownloadEnvironment {
  return {
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    createAnchor: () => document.createElement("a"),
    appendAnchor: (anchor) => document.body.append(anchor as HTMLAnchorElement),
  };
}

/** Build the browser adapter separately so its URL lifecycle is directly testable. */
export function createBrowserStreamStatsDownloadAdapter(
  environment: StreamStatsBrowserDownloadEnvironment =
    defaultBrowserDownloadEnvironment(),
): StreamStatsDownloadAdapter {
  return ({ filename, blob }) => {
    const objectUrl = environment.createObjectUrl(blob);
    let anchor: StreamStatsDownloadAnchor | null = null;
    try {
      anchor = environment.createAnchor();
      anchor.href = objectUrl;
      anchor.download = filename;
      anchor.hidden = true;
      environment.appendAnchor(anchor);
      anchor.click();
    } finally {
      try {
        anchor?.remove();
      } finally {
        environment.revokeObjectUrl(objectUrl);
      }
    }
  };
}

const SYSTEM_CLOCK: StreamStatsClock = { now: Date.now };
const WEBRTC_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StreamStatsFetchResult = {
  value: unknown;
  error: StreamStatsDownloadError | null;
};

function statsRequestError(
  source: StreamStatsDownloadError["source"],
  message: string,
): StreamStatsDownloadError {
  return { source, message };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const advertisedLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(advertisedLength) &&
    advertisedLength > MAX_SERVER_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => {});
    throw new StreamStatsResponseTooLargeError();
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_SERVER_RESPONSE_BYTES) {
      throw new StreamStatsResponseTooLargeError();
    }
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SERVER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new StreamStatsResponseTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

async function fetchStatsJson(
  fetcher: StreamStatsFetch,
  source: StreamStatsDownloadError["source"],
  path: string,
  options: {
    preserveErrorBody?: boolean;
    requestTimeoutMs: number;
  },
): Promise<StreamStatsFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.requestTimeoutMs,
  );
  try {
    let response: Response;
    try {
      response = await fetcher(path, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      return {
        value: null,
        error: statsRequestError(
          source,
          controller.signal.aborted
            ? `${source} request timed out`
            : `${source} request failed`,
        ),
      };
    }

    if (!response.ok && !options.preserveErrorBody) {
      await response.body?.cancel().catch(() => {});
      return {
        value: null,
        error: statsRequestError(
          source,
          `${source} request failed with HTTP ${response.status}`,
        ),
      };
    }

    let value: unknown;
    try {
      value = await readBoundedJson(response);
    } catch (error) {
      const message = controller.signal.aborted
        ? `${source} request timed out`
        : error instanceof StreamStatsResponseTooLargeError
          ? `${source} response was too large`
          : response.ok
            ? `${source} response was not valid JSON`
            : `${source} request failed with HTTP ${response.status}`;
      return { value: null, error: statsRequestError(source, message) };
    }

    return {
      value,
      error: response.ok
        ? null
        : statsRequestError(
            source,
            `${source} request failed with HTTP ${response.status}`,
          ),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function healthSerial(value: unknown): string | null {
  if (!isRecord(value) || typeof value.serial !== "string") return null;
  return value.serial;
}

/**
 * Sample server and viewer statistics, then download one redacted JSON file.
 * Server failures are represented in `errors`; they never suppress the export.
 */
export async function downloadStreamStats(
  input: StreamStatsDownloadInput,
  dependencies: StreamStatsDownloadDependencies = {},
): Promise<StreamStatsDownloadResult> {
  const fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const clock = dependencies.clock ?? SYSTEM_CLOCK;
  const download = dependencies.download ??
    createBrowserStreamStatsDownloadAdapter();
  const requestTimeoutMs =
    typeof dependencies.requestTimeoutMs === "number" &&
      Number.isFinite(dependencies.requestTimeoutMs) &&
      dependencies.requestTimeoutMs > 0
      ? Math.min(dependencies.requestTimeoutMs, MAX_REQUEST_TIMEOUT_MS)
      : DEFAULT_REQUEST_TIMEOUT_MS;
  const now = clock.now();
  const sampledAt = new Date(
    Number.isFinite(now) ? now : 0,
  ).toISOString();

  const healthRequest = fetchStatsJson(fetcher, "health", "/health", {
    preserveErrorBody: true,
    requestTimeoutMs,
  });
  let webRtcRequest: Promise<StreamStatsFetchResult> | null = null;
  let webRtcInputError: StreamStatsDownloadError | null = null;
  if (input.transport === "webrtc") {
    if (
      input.webRtcSessionId === null ||
      !WEBRTC_SESSION_ID.test(input.webRtcSessionId)
    ) {
      webRtcInputError = {
        source: "webrtc",
        message: "WebRTC session ID is unavailable",
      };
    } else {
      webRtcRequest = fetchStatsJson(
        fetcher,
        "webrtc",
        `/webrtc/stats?sessionId=${encodeURIComponent(input.webRtcSessionId)}`,
        { requestTimeoutMs },
      );
    }
  }

  const [healthResult, webRtcResult] = await Promise.all([
    healthRequest,
    webRtcRequest ?? Promise.resolve(null),
  ]);

  const errors: StreamStatsDownloadError[] = [];
  if (healthResult.error) errors.push(healthResult.error);
  if (webRtcInputError) errors.push(webRtcInputError);
  if (webRtcResult?.error) errors.push(webRtcResult.error);

  const rawHealth = healthResult.value;
  const document: StreamStatsDocument = {
    schemaVersion: STREAM_STATS_SCHEMA_VERSION,
    sampledAt,
    viewer: buildStreamStatsViewerSnapshot(
      input.transport,
      input.viewerState,
    ),
    server: {
      health: sanitizeStreamStatsValue(rawHealth),
      webrtc: sanitizeStreamStatsValue(webRtcResult?.value ?? null),
    },
    errors,
  };
  const filename = streamStatsDownloadFilename(
    healthSerial(rawHealth),
    input.transport,
    sampledAt,
  );
  const blob = streamStatsDocumentBlob(document);
  await download({ filename, blob });
  return { filename, blob, document };
}
