import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  bg,
  border,
  ChevronDownIcon,
  font,
  icon,
  isFocusVisible,
  radius,
  text,
  textSize,
} from "../primitives";
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
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focused, setFocused] = useState(false);
  // A grid row, so not `Button`; the states follow `DeviceListItem`, the repo's other list row.
  return (
    <button
      type="button"
      role="listitem"
      aria-pressed={selected}
      title={request.url}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onFocus={(event) => setFocused(isFocusVisible(event))}
      onBlur={() => setFocused(false)}
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
        backgroundColor: selected ? bg.hover : hovered ? bg.element : "transparent",
        borderBottom: `1px solid ${border.default}`,
        boxShadow: focused ? `inset 0 0 0 2px ${border.secondary}` : "none",
        transition: "background-color 150ms ease, transform 100ms ease",
        transform: pressed ? "scale(0.98)" : undefined,
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

/** The selected request's headers and bodies. Exported for tests. */
export function RequestDetails({
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
  // Kept across selections, so a block opened or closed for one request stays that way for the
  // next. Only the bodies start open; the rest is a click away.
  const [opened, setOpened] = useState<Readonly<Record<string, boolean>>>({});
  const block = (title: string) => ({
    title,
    open: opened[title] ?? title.endsWith("body"),
    onOpenChange: (open: boolean) => setOpened((current) => ({ ...current, [title]: open })),
  });
  const requestHeaders = Object.entries(request.requestHeaders ?? {});
  const responseHeaders = Object.entries(request.responseHeaders ?? {});
  const responseBodyBlock = block("Response body");
  // An open body block is the ask: load the body once the response is complete. A failed load
  // waits for Try again rather than retrying on its own.
  const loadBody = done && responseBodyBlock.open && responseBody === undefined;
  const requestBodyRef = useRef(onRequestResponseBody);
  useEffect(() => {
    requestBodyRef.current = onRequestResponseBody;
  });
  useEffect(() => {
    if (loadBody) requestBodyRef.current();
  }, [loadBody, request.id]);
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
      <DetailBlock {...block("General")}>
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
      <DetailBlock {...block("Request headers")} count={requestHeaders.length}>
        <KeyValues entries={requestHeaders} empty="No headers reported." />
      </DetailBlock>
      {request.requestBody ? (
        <DetailBlock {...block("Request body")}>
          <JsonBody body={request.requestBody} />
        </DetailBlock>
      ) : null}
      <DetailBlock {...block("Response headers")} count={responseHeaders.length}>
        <KeyValues entries={responseHeaders} empty="No response yet." />
      </DetailBlock>
      <DetailBlock {...responseBodyBlock}>
        {responseBody?.state === "loaded" ? (
          responseBody.base64Encoded ? (
            <SectionNote>{`Binary body, ${formatSize(Math.floor((responseBody.body.length * 3) / 4))} (base64).`}</SectionNote>
          ) : (
            <>
              {shortBodyNote(responseBody.body, request.responseHeaders)}
              <JsonBody body={responseBody.body} />
            </>
          )
        ) : responseBody?.state === "error" ? (
          <div
            style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8 }}
          >
            <SectionNote role="alert">{responseBody.message}</SectionNote>
            <SidebarActionButton disabled={!done} onClick={onRequestResponseBody}>
              Try again
            </SidebarActionButton>
          </div>
        ) : (
          <SectionNote>
            {request.failed
              ? "The request failed, so there is no body."
              : done
                ? "Loading…"
                : "The body loads when the response completes."}
          </SectionNote>
        )}
      </DetailBlock>
    </div>
  );
}

/** One part of the details, which the user can fold away. */
function DetailBlock({
  title,
  count,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  /** Shown beside the title, so a closed block still says how much it holds. */
  count?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const contentId = useId();
  const [focused, setFocused] = useState(false);
  return (
    <section
      aria-label={title}
      style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => onOpenChange(!open)}
        onFocus={(event) => setFocused(isFocusVisible(event))}
        onBlur={() => setFocused(false)}
        style={{
          ...textSize["2xs"],
          display: "flex",
          alignItems: "center",
          gap: 4,
          alignSelf: "flex-start",
          padding: "2px 4px 2px 0",
          border: 0,
          borderRadius: radius.sm,
          outline: "none",
          boxShadow: focused ? `0 0 0 2px ${border.secondary}` : "none",
          backgroundColor: "transparent",
          fontFamily: "inherit",
          fontWeight: 600,
          color: text.secondary,
          textTransform: "uppercase",
          cursor: "pointer",
        }}
      >
        <ChevronDownIcon
          size={12}
          strokeWidth={2}
          color={icon.secondary}
          style={{ flexShrink: 0, transform: open ? undefined : "rotate(-90deg)" }}
        />
        {title}
        {count !== undefined ? (
          <span style={{ color: text.tertiary, fontWeight: 400 }}>{count}</span>
        ) : null}
      </button>
      {open ? <div id={contentId}>{children}</div> : null}
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
  return <pre style={bodyBox}>{children || "(empty)"}</pre>;
}

const monoXs: CSSProperties = { ...textSize["2xs"], fontFamily: font.mono, fontWeight: 400 };
const bodyBox: CSSProperties = {
  ...monoXs,
  margin: 0,
  maxHeight: 320,
  overflow: "auto",
  padding: 8,
  borderRadius: radius.sm,
  backgroundColor: bg.default,
  color: text.default,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};
/** A JSON line: long strings wrap under their own line rather than past the panel. */
const jsonLine: CSSProperties = { ...monoXs, overflowWrap: "anywhere", whiteSpace: "pre-wrap" };
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

/** Above this size a JSON body opens only its first levels, so a large one stays quick to show. */
const JSON_OPEN_ALL_CHARS = 20_000;
const JSON_OPEN_DEPTH = 2;

/** A body as a JSON tree whose objects and arrays fold, or as text when it is not JSON. */
export function JsonBody({ body }: { body: string }) {
  const parsed = useMemo(() => {
    try {
      const value: unknown = JSON.parse(body);
      return typeof value === "object" && value !== null ? { value } : null;
    } catch {
      return null;
    }
  }, [body]);
  if (!parsed) return <BodyText>{body}</BodyText>;
  return (
    <div role="tree" aria-label="JSON body" style={{ ...bodyBox, whiteSpace: undefined }}>
      <JsonNode
        value={parsed.value}
        depth={0}
        last
        openDepth={body.length > JSON_OPEN_ALL_CHARS ? JSON_OPEN_DEPTH : Infinity}
      />
    </div>
  );
}

function JsonNode({
  name,
  value,
  depth,
  last,
  openDepth,
}: {
  /** The key in the parent object; array items have none. */
  name?: string;
  value: unknown;
  depth: number;
  last: boolean;
  openDepth: number;
}) {
  const [open, setOpen] = useState(depth < openDepth);
  const [focused, setFocused] = useState(false);
  const comma = last ? "" : ",";
  const key =
    name === undefined ? null : (
      <>
        <span style={{ color: text.secondary }}>{JSON.stringify(name)}</span>
        {": "}
      </>
    );
  const indent = { paddingLeft: depth * JSON_INDENT };

  if (typeof value !== "object" || value === null) {
    return (
      <div role="treeitem" style={{ ...indent, ...jsonLine }}>
        <span style={{ display: "inline-block", width: JSON_TOGGLE }} />
        {key}
        <JsonValue value={value} />
        {comma}
      </div>
    );
  }

  const array = Array.isArray(value);
  const entries: Array<[string | undefined, unknown]> = array
    ? value.map((item) => [undefined, item])
    : Object.entries(value);
  const [opening, closing] = array ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) {
    return (
      <div role="treeitem" style={{ ...indent, ...jsonLine }}>
        <span style={{ display: "inline-block", width: JSON_TOGGLE }} />
        {key}
        {opening}
        {closing}
        {comma}
      </div>
    );
  }
  const summary = array
    ? `${entries.length} ${entries.length === 1 ? "item" : "items"}`
    : `${entries.length} ${entries.length === 1 ? "key" : "keys"}`;
  return (
    <div role="treeitem" aria-expanded={open}>
      <button
        type="button"
        aria-label={`${open ? "Collapse" : "Expand"} ${name ?? (array ? "array" : "object")}`}
        onClick={() => setOpen(!open)}
        onFocus={(event) => setFocused(isFocusVisible(event))}
        onBlur={() => setFocused(false)}
        style={{
          ...monoXs,
          ...indent,
          ...jsonLine,
          display: "block",
          width: "100%",
          boxSizing: "border-box",
          margin: 0,
          paddingTop: 0,
          paddingBottom: 0,
          paddingRight: 0,
          border: 0,
          borderRadius: radius.xs,
          outline: "none",
          boxShadow: focused ? `inset 0 0 0 2px ${border.secondary}` : "none",
          backgroundColor: "transparent",
          color: text.default,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <ChevronDownIcon
          size={JSON_TOGGLE - 2}
          strokeWidth={2}
          color={icon.secondary}
          style={{
            display: "inline-block",
            marginRight: 2,
            verticalAlign: "middle",
            transform: open ? undefined : "rotate(-90deg)",
          }}
        />
        {key}
        {opening}
        {open ? null : (
          <>
            <span style={{ color: text.tertiary }}>{` ${summary} `}</span>
            {closing}
            {comma}
          </>
        )}
      </button>
      {open ? (
        <>
          {entries.map(([childName, child], index) => (
            <JsonNode
              key={childName ?? index}
              name={childName}
              value={child}
              depth={depth + 1}
              last={index === entries.length - 1}
              openDepth={openDepth}
            />
          ))}
          <div style={{ ...indent, ...jsonLine }}>
            <span style={{ display: "inline-block", width: JSON_TOGGLE }} />
            {closing}
            {comma}
          </div>
        </>
      ) : null}
    </div>
  );
}

function JsonValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <span style={{ color: text.success }}>{JSON.stringify(value)}</span>;
  }
  if (value === null) return <span style={{ color: text.tertiary }}>null</span>;
  return <span style={{ color: text.info }}>{String(value)}</span>;
}

const JSON_INDENT = 12;
const JSON_TOGGLE = 12;
