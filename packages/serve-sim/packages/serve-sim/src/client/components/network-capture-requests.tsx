import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import {
  fetchCapturedBody,
  type CapturedBody,
  type CapturedRequest,
} from "../hooks/use-capture-stream";
import { formatRate } from "../utils/format-metrics";

export function formatBytes(bytes: number): string {
  return formatRate(bytes).replace("/s", "");
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function statusTint(request: CapturedRequest): string {
  if (request.failure || (request.status ?? 0) >= 500) return "bg-red-500/15 text-red-300";
  if (request.status === null) return "bg-white/10 text-white/50";
  if (request.status >= 400) return "bg-amber-500/15 text-amber-300";
  if (request.status >= 300) return "bg-sky-500/15 text-sky-300";
  return "bg-emerald-500/15 text-emerald-300";
}

function splitUrl(raw: string): { host: string; path: string } {
  try {
    const url = new URL(raw);
    return { host: url.host, path: `${url.pathname}${url.search}` || "/" };
  } catch {
    return { host: "", path: raw };
  }
}

export interface DomainGroup {
  host: string;
  requests: CapturedRequest[];
  bytes: number;
  failed: number;
}

export function isFailedRequest(request: CapturedRequest): boolean {
  return !!request.failure || (request.status ?? 0) >= 400;
}

export function groupByDomain(requests: CapturedRequest[]): DomainGroup[] {
  const groups = new Map<string, DomainGroup>();
  for (const request of requests) {
    const { host } = splitUrl(request.url);
    const key = host || "unknown";
    const group = groups.get(key) ?? { host: key, requests: [], bytes: 0, failed: 0 };
    group.requests.push(request);
    group.bytes += request.requestBytes + request.responseBytes;
    if (isFailedRequest(request)) group.failed++;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function DomainSection({
  group,
  udid,
  slowestMs,
}: {
  group: DomainGroup;
  udid: string;
  slowestMs: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-white/5 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((on) => !on)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 py-1.5 text-left"
      >
        {open ? (
          <ChevronDown aria-hidden="true" className="w-3 h-3 shrink-0 text-white/70" />
        ) : (
          <ChevronRight aria-hidden="true" className="w-3 h-3 shrink-0 text-white/70" />
        )}
        <span className="flex-1 truncate text-[11px] text-white/80" title={group.host}>
          {group.host}
        </span>
        {group.failed > 0 && (
          <span className="shrink-0 rounded bg-red-500/15 px-1.5 text-[10px] tabular-nums text-red-300">
            {group.failed} failed
          </span>
        )}
        <span className="shrink-0 text-[10px] tabular-nums text-white/30">
          {group.requests.length} req · {formatBytes(group.bytes)}
        </span>
      </button>
      {open && (
        <div className="pl-3">
          {group.requests.map((request) => (
            <RequestRow
              key={requestKey(request)}
              request={request}
              udid={udid}
              slowestMs={slowestMs}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TimingBar({ request, slowestMs }: { request: CapturedRequest; slowestMs: number }) {
  const total = request.durationMs ?? 0;
  const wait = Math.min(request.ttfbMs ?? 0, total);
  const scale = (ms: number) => `${Math.max(0, Math.min(100, (ms / slowestMs) * 100))}%`;

  if (request.failure) {
    return (
      <div className="mt-1.5 h-1 rounded-sm bg-white/5">
        <div className="h-full rounded-sm bg-red-400/50" style={{ width: scale(total) }} />
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex h-1 rounded-sm bg-white/5 overflow-hidden">
      <div className="h-full bg-white/25" style={{ width: scale(wait) }} />
      <div className="h-full bg-sky-400/60" style={{ width: scale(total - wait) }} />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <>
      <span className="text-white/30">{label}</span>
      <span className="text-white/70 tabular-nums">{value}</span>
    </>
  );
}

export function RequestFacts({ request }: { request: CapturedRequest }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 text-[10px]">
      <Fact label="Method" value={request.method} />
      <Fact label="Type" value={request.mimeType} />
      <Fact label="Sent" value={request.requestBytes > 0 ? formatBytes(request.requestBytes) : null} />
      <Fact label="Received" value={request.responseBytes > 0 ? formatBytes(request.responseBytes) : null} />
      <Fact label="Waiting" value={request.ttfbMs !== null ? formatMs(request.ttfbMs) : null} />
      <Fact label="Total" value={request.durationMs !== null ? formatMs(request.durationMs) : null} />
    </div>
  );
}

function DetailSection({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-white/5">
      <button
        type="button"
        onClick={() => setOpen((on) => !on)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 py-1 text-left"
      >
        {open ? (
          <ChevronDown aria-hidden="true" className="w-2.5 h-2.5 shrink-0 text-white/70" />
        ) : (
          <ChevronRight aria-hidden="true" className="w-2.5 h-2.5 shrink-0 text-white/70" />
        )}
        <span className="flex-1 text-[10px] text-white/50">{label}</span>
        <span className="text-[10px] tabular-nums text-white/30">{hint}</span>
      </button>
      {open && <div className="pb-1">{children}</div>}
    </div>
  );
}

/**
 * A row's React key. Ids restart at r1 in every capture session, so the start time is part of it:
 * a new session's r1 must not inherit the old r1's expanded state or fetched body.
 */
export function requestKey(request: CapturedRequest): string {
  return `${request.id}@${request.startedAt}`;
}

export function RequestRow({
  request,
  udid,
  slowestMs,
}: {
  request: CapturedRequest;
  udid: string;
  slowestMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [body, setBody] = useState<CapturedBody | null>(null);
  const [loading, setLoading] = useState(false);
  const { host, path } = splitUrl(request.url);
  const payload = Math.max(request.requestBytes, request.responseBytes);

  const settled = request.status !== null || request.failure !== null;

  useEffect(() => {
    if (!expanded || !settled) return;
    let active = true;
    setBody(null);
    setLoading(true);
    void fetchCapturedBody(request.id, udid).then((captured) => {
      if (!active) return;
      setBody(captured);
      setLoading(false);
    });
    return () => { active = false; };
  }, [expanded, settled, request.id, request.startedAt, udid]);

  return (
    <div className="py-1.5 border-b border-white/5 last:border-b-0">
      <button type="button" onClick={() => setExpanded((open) => !open)} className="w-full text-left">
        <div className="flex items-center gap-1.5">
          <span className={`shrink-0 rounded px-1 text-[10px] tabular-nums ${statusTint(request)}`}>
            {request.failure ? "err" : (request.status ?? "···")}
          </span>
          <span className="flex-1 truncate text-[11px] text-white/80" title={request.url}>
            {path}
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-white/40">{formatBytes(payload)}</span>
        </div>
        <TimingBar request={request} slowestMs={slowestMs} />
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-white/30">
          <span className="shrink-0">{request.method}</span>
          <span className="flex-1 truncate">{host}</span>
          <span className="shrink-0 tabular-nums">
            {request.durationMs !== null ? formatMs(request.durationMs) : ""}
          </span>
        </div>
      </button>
      {expanded && (
        <div className="mt-1.5 pl-2 flex flex-col gap-1.5">
          <span className="break-all text-[10px] leading-snug text-white/40">{request.url}</span>
          {request.failure && (
            <span className="rounded bg-red-500/10 px-1.5 py-1 text-[10px] leading-snug text-red-300">
              {request.failure}
            </span>
          )}
          <RequestFacts request={request} />
          {loading && <span className="text-[10px] text-white/30">Loading…</span>}
          {body && <BodyDetail body={body} />}
        </div>
      )}
    </div>
  );
}

function BodyDetail({ body }: { body: CapturedBody }) {
  const requestCount = Object.keys(body.requestHeaders).length;
  const responseCount = Object.keys(body.responseHeaders).length;
  return (
    <div className="flex flex-col">
      {requestCount > 0 && (
        <DetailSection label="Request headers" hint={String(requestCount)}>
          <HeaderList headers={body.requestHeaders} />
        </DetailSection>
      )}
      {responseCount > 0 && (
        <DetailSection label="Response headers" hint={String(responseCount)}>
          <HeaderList headers={body.responseHeaders} />
        </DetailSection>
      )}
      <BodySection
        label="Request body"
        text={body.requestBody}
        binary={body.requestBinary}
        truncated={body.requestTruncated}
      />
      <BodySection
        label="Response body"
        text={body.responseBody}
        binary={body.responseBinary}
        truncated={body.responseTruncated}
      />
    </div>
  );
}

export function BodySection({
  label,
  text,
  binary,
  truncated,
}: {
  label: string;
  text: string | null;
  binary: boolean;
  truncated: boolean;
}) {
  if (binary) {
    return (
      <DetailSection label={label} hint="binary">
        <span className="text-[10px] text-white/40">Binary body — not shown.</span>
      </DetailSection>
    );
  }
  if (!text) return null;
  return (
    <DetailSection label={label} hint={truncated ? "truncated" : formatBytes(new TextEncoder().encode(text).byteLength)}>
      <pre className="thin-scroll max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 px-1.5 py-1 text-[10px] text-white/60">
        {text}
      </pre>
    </DetailSection>
  );
}

function HeaderList({ headers }: { headers: Record<string, string> }) {
  return (
    <div className="flex flex-col gap-0.5 text-[10px] leading-snug">
      {Object.entries(headers).map(([name, value]) => (
        <span key={name} className="break-all">
          <span className="text-white/30">{name}</span> <span className="text-white/60">{value}</span>
        </span>
      ))}
    </div>
  );
}
