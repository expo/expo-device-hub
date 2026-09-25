import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Check, Copy, Download, ListFilter, Pause, Play, Trash2, TriangleAlert, X } from "lucide-react";
import { useCopy } from "../hooks/use-copy";
import {
  DEVICE_LOG_LEVELS,
  deviceLogMatches,
  formatLogClock,
  formatLogLine,
  type DeviceLogLevel,
} from "../utils/device-log-format";
import { LOG_ROW_EXPAND_EXTRA, LOG_ROW_HEIGHT, logWindow } from "../utils/logs-window";
import { useDeviceLogs } from "../hooks/use-device-logs";
import type { DisplayLine } from "../utils/log-rows";
import { simEndpoint } from "../utils/sim-endpoint";
import { triggerBrowserDownload } from "../utils/screenshot-capture";
import { PanelTitle } from "../panel";
import { onDrawerEscape } from "../utils/drawer-escape";
import { PANEL_BACKGROUND } from "./panel-colors";
import { Dropdown, DropdownOption } from "./select";
import { ResizeEdge } from "./resize-handle";
import { Tooltip } from "./tooltip";

const NEAR_BOTTOM_PX = 48;

type LevelEnabled = Record<DeviceLogLevel, boolean>;

// log-buffer.ts streams at --level info, so debug records never reach us.
const LOG_LEVELS = DEVICE_LOG_LEVELS.filter((level) => level !== "debug");

const DEFAULT_LEVELS: LevelEnabled = {
  debug: false,
  info: true,
  default: true,
  error: true,
  fault: true,
};

export function LogsDrawer({
  open,
  hidden = false,
  onClose,
  udid,
  logsEndpoint,
  currentAppPid,
  height,
  leftInset,
  rightInset,
  onResizePointerDown,
}: {
  open: boolean;
  hidden?: boolean;
  onClose: () => void;
  udid: string;
  logsEndpoint?: string;
  currentAppPid?: number | null;
  height: number;
  leftInset: number;
  rightInset: number;
  onResizePointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<"all" | "app">("all");
  const [levels, setLevels] = useState<LevelEnabled>(DEFAULT_LEVELS);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [copied, copy] = useCopy();
  const path = useMemo(
    () => logsEndpoint ?? `${simEndpoint("logs")}?device=${encodeURIComponent(udid)}`,
    [logsEndpoint, udid]
  );

  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const { lines, paused, errored, clear, togglePause } = useDeviceLogs(path, open);
  const shown = open && !hidden;

  useEffect(() => {
    if (!open) return;
    setExpandedId(null);
    stickRef.current = true;
  }, [open, path]);


  useEffect(() => {
    if (!shown) return;
    return onDrawerEscape(document, () => {
      if (filter.trim()) setFilter("");
      else onClose();
    });
  }, [shown, onClose, filter]);

  const visible = useMemo(() => {
    const needle = filter.trim();
    const appPid = scope === "app" ? currentAppPid : undefined;
    if (!needle && scope !== "app" && LOG_LEVELS.every((level) => levels[level])) {
      return lines;
    }
    return lines.filter((line) => {
      if (!levels[line.level]) return false;
      if (appPid !== undefined && (appPid == null || line.pid !== appPid)) return false;
      return needle ? deviceLogMatches(line, needle) : true;
    });
  }, [lines, filter, levels, scope, currentAppPid]);

  useEffect(() => {
    if (visible.length === 0) stickRef.current = true;
  }, [visible.length]);

  const live = open && !paused && !errored;
  const appScopeAvailable = currentAppPid != null;
  const levelsFiltered = LOG_LEVELS.some((level) => levels[level] !== DEFAULT_LEVELS[level]);

  const visibleText = (): string => visible.map(formatLogLine).join("\n");

  const copyVisible = (): void => copy(visibleText());

  const downloadVisible = (): void => {
    const url = URL.createObjectURL(new Blob([visibleText()], { type: "text/plain" }));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
    triggerBrowserDownload(url, `serve-sim-logs-${stamp}.log`);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const filteredOut = Boolean(filter.trim()) || scope === "app" || levelsFiltered;
  const emptyLabel = errored
    ? "Disconnected"
    : scope === "app" && !appScopeAvailable
      ? "No current app"
      : filteredOut
        ? "No matches"
        : "No log lines yet";

  return (
    <aside
      data-logs=""
      aria-hidden={!shown}
      aria-label="Device logs"
      className="fixed z-34 flex min-w-0 flex-col overflow-hidden border-t border-white/10 bg-panel-bg text-white/90 shadow-[0_-8px_32px_rgba(0,0,0,0.35)] backdrop-blur-[18px] [font-family:-apple-system,system-ui,sans-serif] [transition:transform_0.25s_ease,opacity_0.2s_ease]"
      style={{
        height,
        left: leftInset,
        right: rightInset,
        bottom: 0,
        backgroundColor: PANEL_BACKGROUND,
        transform: shown ? "translateY(0)" : "translateY(100%)",
        opacity: shown ? 1 : 0,
        pointerEvents: shown ? "auto" : "none",
      }}
    >
      <ResizeEdge onPointerDown={onResizePointerDown} />
      <div className="flex shrink-0 items-center gap-2 border-b border-white/8 px-3 py-1.5">
        <PanelTitle>Logs</PanelTitle>
        {errored ? (
          <Tooltip label="The log stream disconnected">
            <span role="status" className="flex shrink-0 items-center">
              <TriangleAlert aria-hidden="true" className="size-3.5 text-amber-400" />
              <span className="sr-only">The log stream disconnected</span>
            </span>
          </Tooltip>
        ) : (
          <span
            className={`size-1.5 shrink-0 rounded-full ${live ? "bg-emerald-400" : "bg-transparent"}`}
            aria-label={live ? "Live" : undefined}
          />
        )}
        <ScopeButton
          pressed={scope === "all"}
          onClick={() => setScope("all")}
          label="All processes"
        >
          All
        </ScopeButton>
        <ScopeButton
          pressed={scope === "app"}
          onClick={() => setScope("app")}
          label="Current app"
          disabled={!appScopeAvailable}
        >
          App
        </ScopeButton>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter logs"
          placeholder="Filter"
          className="ml-auto box-border h-6 w-36 min-w-6 appearance-none rounded border border-white/10 bg-white/[0.03] px-2 font-mono text-[11px] leading-none text-white/80 placeholder:text-white/30 outline-none focus:border-white/25"
        />
        <div className="flex h-6 shrink-0 items-center gap-0.5">
          <Tooltip label="Log levels">
            <Dropdown
              label="Log levels"
              multiple
              disabled={!shown}
              trigger={<ListFilter size={15} strokeWidth={1.75} />}
              className={`flex h-6 w-6 items-center justify-center rounded hover:bg-white/8 hover:text-white ${
                levelsFiltered ? "text-accent" : "text-[#8e8e93]"
              }`}
            >
              {LOG_LEVELS.map((level) => (
                <DropdownOption
                  key={level}
                  selected={levels[level]}
                  onClick={() => setLevels((prev) => ({ ...prev, [level]: !prev[level] }))}
                >
                  <span className="flex items-center gap-2">
                    <Check size={12} strokeWidth={2.5} className={levels[level] ? "" : "invisible"} />
                    {level.charAt(0).toUpperCase() + level.slice(1)}
                  </span>
                </DropdownOption>
              ))}
            </Dropdown>
          </Tooltip>
          <IconButton label="Download logs" onClick={downloadVisible} disabled={visible.length === 0}>
            <Download size={15} strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label={copied ? "Copied" : "Copy logs"}
            onClick={copyVisible}
            disabled={visible.length === 0}
          >
            <Copy size={15} strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label="Clear"
            onClick={() => {
              clear();
              setExpandedId(null);
            }}
          >
            <Trash2 size={15} strokeWidth={1.75} />
          </IconButton>
          <IconButton label={paused ? "Resume" : "Pause"} onClick={togglePause}>
            {paused ? <Play size={15} strokeWidth={1.75} /> : <Pause size={15} strokeWidth={1.75} />}
          </IconButton>
          <IconButton label="Close logs" onClick={onClose} align="right">
            <X size={15} strokeWidth={1.75} />
          </IconButton>
        </div>
      </div>
      {visible.length === 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-1 items-center justify-center text-[12px] text-white/45"
        >
          {emptyLabel}
        </div>
      ) : (
        <LogList
          listRef={listRef}
          stickRef={stickRef}
          lines={visible}
          expandedId={expandedId}
          onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
        />
      )}
    </aside>
  );
}

function LogList({
  listRef,
  stickRef,
  lines,
  expandedId,
  onToggle,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  stickRef: RefObject<boolean>;
  lines: DisplayLine[];
  expandedId: number | null;
  onToggle: (id: number) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(120);
  const [expandedExtra, setExpandedExtra] = useState(LOG_ROW_EXPAND_EXTRA);
  const scrollRaf = useRef<number | null>(null);
  const scrollTopRef = useRef(0);
  const expandedObserver = useRef<ResizeObserver | null>(null);

  const measureExpanded = useCallback((el: HTMLButtonElement | null) => {
    expandedObserver.current?.disconnect();
    expandedObserver.current = null;
    if (!el) return;
    const report = (): void => setExpandedExtra(Math.max(0, el.offsetHeight - LOG_ROW_HEIGHT));
    report();
    expandedObserver.current = new ResizeObserver(report);
    expandedObserver.current.observe(el);
  }, []);

  useEffect(() => () => expandedObserver.current?.disconnect(), []);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = (): void => {
      setViewportHeight(el.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [listRef]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
    scrollTopRef.current = el.scrollTop;
    setScrollTop(el.scrollTop);
  }, [lines.length, listRef, stickRef]);

  const expandedIndex = expandedId === null ? null : lines.findIndex((line) => line.id === expandedId);
  const win = logWindow(
    lines.length,
    scrollTop,
    viewportHeight,
    expandedIndex === -1 ? null : expandedIndex,
    LOG_ROW_HEIGHT,
    expandedExtra
  );
  const slice = lines.slice(win.start, win.end);

  return (
    <div
      ref={listRef}
      role="list"
      onScroll={() => {
        const el = listRef.current;
        if (!el) return;
        scrollTopRef.current = el.scrollTop;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
        if (scrollRaf.current === null) {
          scrollRaf.current = requestAnimationFrame(() => {
            scrollRaf.current = null;
            setScrollTop(scrollTopRef.current);
          });
        }
      }}
      className="min-h-0 flex-1 overflow-y-auto px-3 py-1 font-mono contain-strict [scrollbar-width:thin]"
    >
      <div style={{ height: win.total, position: "relative" }}>
        <div style={{ transform: `translateY(${win.padTop}px)` }}>
          {slice.map((line) => (
            <LogRow
              key={line.id}
              line={line}
              expanded={expandedId === line.id}
              onToggle={onToggle}
              measureRef={expandedId === line.id ? measureExpanded : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ScopeButton({
  pressed,
  onClick,
  label,
  disabled,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-6 shrink-0 items-center border-0 bg-transparent px-0 text-[11px] leading-none ${
        pressed ? "text-white/85" : "text-white/40 hover:text-white/70"
      } disabled:opacity-30 disabled:hover:text-white/40`}
    >
      {children}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  children,
  disabled,
  align,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  align?: "center" | "right";
}) {
  return (
    <Tooltip label={label} align={align}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className="flex h-6 w-6 items-center justify-center rounded border-0 bg-transparent p-0 text-[#8e8e93] hover:bg-white/8 hover:text-white disabled:text-[#48484a] disabled:hover:bg-transparent disabled:hover:text-[#48484a]"
      >
        {children}
      </button>
    </Tooltip>
  );
}

const LogRow = memo(function LogRow({
  line,
  expanded,
  onToggle,
  measureRef,
}: {
  line: DisplayLine;
  expanded: boolean;
  onToggle: (id: number) => void;
  measureRef?: (el: HTMLButtonElement | null) => void;
}) {
  const time = formatLogClock(line.timestamp);
  const meta = [line.subsystem, line.category].filter(Boolean).join(":");
  const tone =
    line.level === "fault" || line.level === "error" ? "text-white/90" : "text-white/70";
  return (
    <button
      ref={measureRef}
      type="button"
      role="listitem"
      onClick={() => onToggle(line.id)}
      aria-expanded={expanded}
      title={meta ? `${line.process} ${meta}` : line.process}
      className={`flex w-full items-start gap-3 text-left hover:bg-white/[0.04] ${
        expanded ? "min-h-[22px] py-0.5" : "h-[22px] items-center overflow-hidden"
      }`}
    >
      <span className="w-[5.5rem] shrink-0 font-mono text-[11px] leading-5 tabular-nums text-white/35">
        {time || "\u00a0"}
      </span>
      <span className="w-[8.5rem] shrink-0 truncate font-mono text-[11px] leading-5 text-white/40">
        {line.process || "unknown"}
      </span>
      <span className="min-w-0 flex-1 font-mono text-[11px] leading-5">
        <span className={`block ${expanded ? "whitespace-pre-wrap break-all" : "truncate"} ${tone}`}>
          {line.message}
        </span>
        {expanded ? (
          <span className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] leading-4 text-white/35">
            {line.pid !== null && <span>pid {line.pid}</span>}
            {line.library !== "" && line.library !== line.process && <span>{line.library}</span>}
            {meta !== "" && <span>{meta}</span>}
          </span>
        ) : null}
      </span>
    </button>
  );
});
