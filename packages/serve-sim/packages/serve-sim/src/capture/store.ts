/**
 * Unused until #53 reads it. Remove the tag there.
 * @public
 */
export const CAPTURE_SCHEMA_VERSION = 1;

const MAX_REQUESTS = 500;
const TRAFFIC_BUCKET_MS = 100;
const TRAFFIC_WINDOW_BUCKETS = 10;

const MAX_BODY_BYTES = 512 * 1024;
const MAX_TOTAL_BODY_BYTES = 16 * 1024 * 1024;

export interface CapturedRequest {
  id: string;
  method: string;
  url: string;
  status: number | null;
  mimeType: string | null;
  requestBytes: number;
  responseBytes: number;
  /** Unix time in milliseconds, preserved across exports. */
  startedAt: number;
  ttfbMs: number | null;
  durationMs: number | null;
  failure: string | null;
}

export interface CapturedBody {
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody: string | null;
  responseBody: string | null;
  requestTruncated: boolean;
  responseTruncated: boolean;
  requestBinary: boolean;
  responseBinary: boolean;
}

export type CaptureAttachment = "starting" | "capturing" | "not-enabled" | "failed";

export interface CaptureMeta {
  schemaVersion: number;
  udid: string;
  proxyAddress: string | null;
  attachment: CaptureAttachment;
  attachError: string | null;
  droppedOversizedBodies: number;
}

type Listener = (event: CaptureEvent) => void;

export type CaptureEvent =
  | { type: "started"; request: CapturedRequest }
  | { type: "finished"; request: CapturedRequest }
  | { type: "cleared" }
  | { type: "meta"; meta: CaptureMeta };

export class CaptureStore {
  private readonly requests = new Map<string, CapturedRequest>();
  private readonly bodies = new Map<string, CapturedBody>();
  private readonly listeners = new Set<Listener>();
  private totalBodyBytes = 0;
  private seq = 0;
  private readonly traffic = new Map<number, { in: number; out: number }>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  get listenerCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): CapturedRequest[] {
    return [...this.requests.values()];
  }

  body(id: string): CapturedBody | null {
    return this.bodies.get(id) ?? null;
  }

  start(method: string, url: string, startedAt = Date.now()): string {
    const id = `r${++this.seq}`;
    const request: CapturedRequest = {
      id,
      method,
      url,
      status: null,
      mimeType: null,
      requestBytes: 0,
      responseBytes: 0,
      startedAt,
      ttfbMs: null,
      durationMs: null,
      failure: null,
    };
    this.requests.set(id, request);
    this.evictOverflow();
    this.emit({ type: "started", request });
    return id;
  }

  update(id: string, patch: Partial<Omit<CapturedRequest, "id">>, settled = false): void {
    const request = this.requests.get(id);
    if (!request) return;
    Object.assign(request, patch);
    if (settled) this.emit({ type: "finished", request });
  }

  setBody(id: string, body: CapturedBody): void {
    if (!this.requests.has(id)) return;
    const previous = this.bodies.get(id);
    const size = chargedBytes(body);
    const nextTotal = this.totalBodyBytes - (previous ? chargedBytes(previous) : 0) + size;
    if (nextTotal > MAX_TOTAL_BODY_BYTES) return;
    this.bodies.set(id, body);
    this.totalBodyBytes = nextTotal;
  }

  publishMeta(meta: CaptureMeta): void {
    this.emit({ type: "meta", meta });
  }

  clear(): void {
    this.requests.clear();
    this.bodies.clear();
    this.totalBodyBytes = 0;
    this.emit({ type: "cleared" });
  }

  noteTraffic(inBytes: number, outBytes: number, durationMs = 0): void {
    const current = Math.floor(this.now() / TRAFFIC_BUCKET_MS);
    const slices = Math.ceil(Math.max(TRAFFIC_BUCKET_MS, durationMs) / TRAFFIC_BUCKET_MS);
    const share = { in: inBytes / slices, out: outBytes / slices };

    const earliest = Math.max(current - slices + 1, current - TRAFFIC_WINDOW_BUCKETS + 1);
    for (let bucket = earliest; bucket <= current; bucket++) {
      const entry = this.traffic.get(bucket) ?? { in: 0, out: 0 };
      entry.in += share.in;
      entry.out += share.out;
      this.traffic.set(bucket, entry);
    }
    this.pruneTraffic(current);
  }

  throughput(): { netInBytesPerSec: number; netOutBytesPerSec: number } {
    const bucket = Math.floor(this.now() / TRAFFIC_BUCKET_MS);
    this.pruneTraffic(bucket);
    let inTotal = 0;
    let outTotal = 0;
    for (const { in: i, out: o } of this.traffic.values()) {
      inTotal += i;
      outTotal += o;
    }
    return { netInBytesPerSec: Math.round(inTotal), netOutBytesPerSec: Math.round(outTotal) };
  }

  private pruneTraffic(currentBucket: number): void {
    const oldest = currentBucket - TRAFFIC_WINDOW_BUCKETS;
    for (const bucket of this.traffic.keys()) {
      if (bucket <= oldest) this.traffic.delete(bucket);
    }
  }

  private evictOverflow(): void {
    while (this.requests.size > MAX_REQUESTS) {
      const oldest = this.requests.keys().next();
      if (oldest.done) return;
      const body = this.bodies.get(oldest.value);
      if (body) {
        this.totalBodyBytes -= chargedBytes(body);
        this.bodies.delete(oldest.value);
      }
      this.requests.delete(oldest.value);
    }
  }

  private emit(event: CaptureEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Keep notifying the remaining listeners.
      }
    }
  }
}

function chargedBytes(body: CapturedBody): number {
  let total = byteLength(body.requestBody) + byteLength(body.responseBody);
  for (const headers of [body.requestHeaders, body.responseHeaders]) {
    for (const [name, value] of Object.entries(headers)) {
      total += byteLength(name) + byteLength(value);
    }
  }
  return total;
}

function byteLength(text: string | null): number {
  return text == null ? 0 : Buffer.byteLength(text);
}

export function clampBody(buffers: Buffer[]): { text: string | null; truncated: boolean } {
  if (buffers.length === 0) return { text: null, truncated: false };
  const joined = Buffer.concat(buffers);
  if (joined.length <= MAX_BODY_BYTES) return { text: joined.toString("utf8"), truncated: false };
  return { text: joined.subarray(0, MAX_BODY_BYTES).toString("utf8"), truncated: true };
}
