import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { bg, border, font, radius, text, textSize } from "../primitives";
import { CollapsibleSection } from "./CollapsibleSection";
import { SectionNote } from "./SectionNote";
import { SidebarActionButton } from "./SidebarActionButton";
import { SidebarTextInput } from "./SidebarTextInput";

/** One request the app made. Header values arrive already redacted. */
export type NetworkPanelRequest = {
  id: string;
  method: string;
  url: string;
  startedAt: number;
  finishedAt?: number;
  status?: number;
  statusText?: string;
  mimeType?: string;
  resourceType?: string;
  encodedDataLength?: number;
  failed?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
};

export type NetworkPanelStatus = {
  /** `connecting` is the dashboard's own state, before the Hub answers. */
  state: "connecting" | "searching" | "attached" | "unavailable";
  app?: { id: string; deviceName: string };
  message?: string;
};

export type NetworkPanelBody =
  | { state: "loading" }
  | { state: "loaded"; body: string; base64Encoded: boolean }
  | { state: "error"; message: string };

export type NetworkSectionProps = {
  status: NetworkPanelStatus;
  requests: ReadonlyArray<NetworkPanelRequest>;
  /** Response bodies the panel asked for, by request id. */
  responseBodies: Readonly<Record<string, NetworkPanelBody>>;
  onClear: () => void;
  onRequestResponseBody: (id: string) => void;
  /** The section opened or closed; the dashboard watches the app only while it is open. */
  onOpenChange?: (open: boolean) => void;
};

const LIST_HEIGHT = 240;

const SCROLLBAR_CSS = `
.hub-network-scroll::-webkit-scrollbar { width: 12px; }
.hub-network-scroll::-webkit-scrollbar-track { background: transparent; }
.hub-network-scroll::-webkit-scrollbar-thumb {
  background-color: var(--expo-theme-background-selected);
  border-radius: 8px;
  border: 3px solid transparent;
  background-clip: padding-box;
  min-height: 24px;
}
`;

/**
 * The app's HTTP requests, as the React Native inspector reports them: method, status, path,
 * time, and size per row, and the headers and bodies of the selected one.
 */
export function NetworkSection({
  status,
  requests,
  responseBodies,
  onClear,
  onRequestResponseBody,
  onOpenChange,
}: NetworkSectionProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return requests;
    return requests.filter(
      (request) =>
        request.url.toLowerCase().includes(query) ||
        request.method.toLowerCase() === query ||
        String(request.status ?? "").startsWith(query),
    );
  }, [requests, filter]);
  const selected = selectedId ? requests.find((request) => request.id === selectedId) : undefined;

  // Follow new requests while scrolled to the end, like the Logs section.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  return (
    <CollapsibleSection title="Network" open={open} onOpenChange={handleOpenChange}>
      <StatusNote status={status} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", minWidth: 0 }}>
        <span
          style={{
            ...textSize["2xs"],
            fontFamily: font.mono,
            fontWeight: 400,
            color: text.tertiary,
            whiteSpace: "nowrap",
          }}
        >
          {visible.length === requests.length
            ? `${requests.length} ${requests.length === 1 ? "request" : "requests"}`
            : `${visible.length} of ${requests.length}`}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SidebarTextInput
            ariaLabel="Filter requests by URL, method, or status"
            value={filter}
            onChange={setFilter}
            onSubmit={() => {}}
          />
        </div>
        <SidebarActionButton
          disabled={requests.length === 0}
          onClick={() => {
            setSelectedId(null);
            onClear();
          }}
        >
          Clear
        </SidebarActionButton>
      </div>
      <div
        ref={scrollRef}
        className="hub-network-scroll"
        role="list"
        aria-label="Network requests"
        onScroll={(event) => {
          const el = event.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        }}
        style={{
          height: LIST_HEIGHT,
          marginTop: 8,
          overflowY: "auto",
          overflowX: "hidden",
          overflowAnchor: "none",
          border: `1px solid ${border.default}`,
          borderRadius: radius.md,
        }}
      >
        <style>{SCROLLBAR_CSS}</style>
        {visible.length === 0 ? (
          <div
            style={{
              ...textSize.xs,
              display: "flex",
              height: "100%",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 24px",
              textAlign: "center",
              color: text.tertiary,
            }}
          >
            {requests.length > 0
              ? "No requests match the filter."
              : status.state === "attached"
                ? "No requests yet. Use the app to see its traffic here."
                : "Requests appear here once the Hub follows your app."}
          </div>
        ) : (
          visible.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              selected={request.id === selectedId}
              onSelect={() => setSelectedId(request.id === selectedId ? null : request.id)}
            />
          ))
        )}
      </div>
      {selected && (
        <RequestDetails
          request={selected}
          responseBody={responseBodies[selected.id]}
          onRequestResponseBody={() => onRequestResponseBody(selected.id)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </CollapsibleSection>
  );
}

function StatusNote({ status }: { status: NetworkPanelStatus }) {
  if (status.state === "attached" && status.app) {
    return (
      <SectionNote role="status">{`Following ${status.app.id} on ${status.app.deviceName}.`}</SectionNote>
    );
  }
  if (status.state === "connecting")
    return <SectionNote role="status">Connecting to the Hub…</SectionNote>;
  return (
    <SectionNote role={status.state === "unavailable" ? "alert" : "status"}>
      {status.message ?? "Looking for your app on this device…"}
    </SectionNote>
  );
}

function RequestRow({
  request,
  selected,
  onSelect,
}: {
  request: NetworkPanelRequest;
  selected: boolean;
  onSelect: () => void;
}) {
  const { path, host } = splitUrl(request.url);
  return (
    <button
      type="button"
      role="listitem"
      aria-pressed={selected}
      title={request.url}
      onClick={onSelect}
      style={{
        all: "unset",
        boxSizing: "border-box",
        display: "grid",
        gridTemplateColumns: "44px 40px minmax(0, 1fr) auto",
        alignItems: "center",
        columnGap: 8,
        width: "100%",
        padding: "6px 10px",
        cursor: "pointer",
        backgroundColor: selected ? bg.selected : "transparent",
        borderBottom: `1px solid ${border.default}`,
      }}
    >
      <span style={{ ...monoXs, color: text.secondary }}>{request.method}</span>
      <StatusText request={request} />
      <span style={{ minWidth: 0 }}>
        <span style={{ ...ellipsis, ...textSize.xs, display: "block", color: text.default }}>
          {path}
        </span>
        <span style={{ ...ellipsis, ...textSize["2xs"], display: "block", color: text.tertiary }}>
          {host}
        </span>
      </span>
      <span style={{ ...monoXs, color: text.tertiary, textAlign: "right" }}>
        {formatDuration(request)}
        <br />
        {formatSize(request.encodedDataLength)}
      </span>
    </button>
  );
}

function StatusText({ request }: { request: NetworkPanelRequest }) {
  const { label, color } = statusLook(request);
  return <span style={{ ...monoXs, color, fontWeight: 600 }}>{label}</span>;
}

function RequestDetails({
  request,
  responseBody,
  onRequestResponseBody,
  onClose,
}: {
  request: NetworkPanelRequest;
  responseBody: NetworkPanelBody | undefined;
  onRequestResponseBody: () => void;
  onClose: () => void;
}) {
  const done = request.finishedAt !== undefined && !request.failed;
  return (
    <div
      aria-label="Request details"
      style={{
        marginTop: 8,
        padding: 10,
        border: `1px solid ${border.default}`,
        borderRadius: radius.md,
        backgroundColor: bg.subtle,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ ...textSize.xs, fontWeight: 600, flex: 1, color: text.default }}>
          {request.method} {statusLook(request).label}
          {request.statusText ? ` ${request.statusText}` : ""}
        </span>
        <SidebarActionButton onClick={onClose}>Close</SidebarActionButton>
      </div>
      <DetailBlock title="General">
        <KeyValues
          entries={[
            ["URL", request.url],
            ["Type", [request.resourceType, request.mimeType].filter(Boolean).join(" · ") || "—"],
            ["Time", formatDuration(request)],
            ["Size", formatSize(request.encodedDataLength)],
            ...(request.failed ? ([["Error", request.failed]] as Array<[string, string]>) : []),
          ]}
        />
      </DetailBlock>
      <DetailBlock title="Request headers">
        <KeyValues
          entries={Object.entries(request.requestHeaders ?? {})}
          empty="No headers reported."
        />
      </DetailBlock>
      {request.requestBody ? (
        <DetailBlock title="Request body">
          <BodyText>{request.requestBody}</BodyText>
        </DetailBlock>
      ) : null}
      <DetailBlock title="Response headers">
        <KeyValues
          entries={Object.entries(request.responseHeaders ?? {})}
          empty="No response yet."
        />
      </DetailBlock>
      <DetailBlock title="Response body">
        {responseBody?.state === "loaded" ? (
          responseBody.base64Encoded ? (
            <SectionNote>{`Binary body, ${formatSize(Math.floor((responseBody.body.length * 3) / 4))} (base64).`}</SectionNote>
          ) : (
            <>
              {shortBodyNote(responseBody.body, request.responseHeaders)}
              <BodyText>{prettyJson(responseBody.body)}</BodyText>
            </>
          )
        ) : responseBody?.state === "error" ? (
          <SectionNote role="alert">{responseBody.message}</SectionNote>
        ) : (
          <div>
            <SidebarActionButton
              disabled={!done || responseBody?.state === "loading"}
              onClick={onRequestResponseBody}
            >
              {responseBody?.state === "loading" ? "Loading…" : "Load body"}
            </SidebarActionButton>
          </div>
        )}
      </DetailBlock>
    </div>
  );
}

function DetailBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <span
        style={{
          ...textSize["2xs"],
          fontWeight: 600,
          color: text.secondary,
          textTransform: "uppercase",
        }}
      >
        {title}
      </span>
      {children}
    </section>
  );
}

function KeyValues({
  entries,
  empty,
}: {
  entries: ReadonlyArray<[string, string]>;
  empty?: string;
}) {
  if (entries.length === 0) return <SectionNote>{empty ?? "—"}</SectionNote>;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 2fr) minmax(0, 3fr)",
        gap: "2px 8px",
      }}
    >
      {entries.map(([name, value]) => (
        <div key={name} style={{ display: "contents" }}>
          <span style={{ ...monoXs, color: text.tertiary, overflowWrap: "anywhere" }}>{name}</span>
          <span style={{ ...monoXs, color: text.default, overflowWrap: "anywhere" }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

function BodyText({ children }: { children: string }) {
  return (
    <pre
      style={{
        ...monoXs,
        margin: 0,
        maxHeight: 220,
        overflow: "auto",
        padding: 8,
        borderRadius: radius.sm,
        backgroundColor: bg.default,
        color: text.default,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {children || "(empty)"}
    </pre>
  );
}

const monoXs: CSSProperties = { ...textSize["2xs"], fontFamily: font.mono, fontWeight: 400 };
const ellipsis: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export function statusLook(
  request: Pick<NetworkPanelRequest, "status" | "failed" | "finishedAt">,
): {
  label: string;
  color: string;
} {
  if (request.failed) return { label: "ERR", color: text.danger };
  if (request.status === undefined) {
    return { label: request.finishedAt === undefined ? "…" : "—", color: text.tertiary };
  }
  if (request.status >= 500) return { label: String(request.status), color: text.danger };
  if (request.status >= 400) return { label: String(request.status), color: text.warning };
  if (request.status >= 300) return { label: String(request.status), color: text.info };
  return { label: String(request.status), color: text.success };
}

export function splitUrl(url: string): { path: string; host: string } {
  try {
    const parsed = new URL(url);
    return { path: `${parsed.pathname}${parsed.search}` || "/", host: parsed.host };
  } catch {
    return { path: url, host: "" };
  }
}

export function formatDuration(
  request: Pick<NetworkPanelRequest, "startedAt" | "finishedAt">,
): string {
  if (request.finishedAt === undefined) return "pending";
  const ms = Math.max(0, request.finishedAt - request.startedAt);
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A note when the app's inspector returned fewer bytes than the response's Content-Length: React
 * Native can report a large body cut short, which also leaves JSON unparsed.
 */
function shortBodyNote(body: string, headers: Record<string, string> | undefined): ReactNode {
  const declared = Number(
    Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "content-length")?.[1],
  );
  const received = new TextEncoder().encode(body).length;
  if (!Number.isFinite(declared) || received >= declared) return null;
  return (
    <SectionNote>{`The app reported ${formatSize(received)} of ${formatSize(declared)}; the body is cut short.`}</SectionNote>
  );
}

function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
