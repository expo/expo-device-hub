import type { SelectedOccurrence } from "../../crash/protocol";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { CrashFrame } from "../../crash/report";
import type { CrashOccurrence, CrashSummary } from "../../crash/store";
import { collapseSystemFrames, formatCrashAgo, formatOccurrenceClock } from "../utils/crash-format";
import { useCopy } from "../hooks/use-copy";
import { formatLogClock, parseDeviceLogJson } from "../utils/device-log-format";
import { useResizableCenteredWidth } from "../hooks/use-resizable-width";

const CRASH_DETAIL_DEFAULT_WIDTH = 720;
const CRASH_DETAIL_MIN_WIDTH = 360;
const CRASH_DETAIL_MAX_WIDTH = 1_400;

function messageOf(raw: string): string {
  return parseDeviceLogJson(raw)?.message ?? raw;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2">
      <span className="text-[10px] uppercase tracking-[0.08em] text-white/35">{label}</span>
      <span className="font-mono text-[11px] break-all text-white/70">{value}</span>
    </div>
  );
}

function FrameRow({ index, frame }: { index: number; frame: CrashFrame }) {
  return (
    <div
      className={`grid grid-cols-[24px_140px_1fr] gap-2 font-mono text-[10px] ${
        frame.appOwned ? "text-white/75" : "text-white/35"
      }`}
    >
      <span className="text-white/25">{index}</span>
      <span className="truncate">{frame.image}</span>
      <span className="break-all">{frame.symbol ?? `+${frame.imageOffset ?? 0}`}</span>
    </div>
  );
}

function StackTrace({ frames }: { frames: CrashFrame[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const rows = collapseSystemFrames(frames);

  useEffect(() => {
    setExpanded(new Set());
  }, [frames]);

  const toggle = (start: number): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(start)) next.delete(start);
      else next.add(start);
      return next;
    });
  };

  if (frames.length === 0) {
    return <p className="text-[11px] text-white/35">No stack frames</p>;
  }

  return (
    <ol className="flex flex-col gap-0.5">
      {rows.map((row) => {
        if (row.kind === "frame") {
          return (
            <li key={row.index}>
              <FrameRow index={row.index} frame={row.frame} />
            </li>
          );
        }
        const open = expanded.has(row.start);
        return (
          <li key={`collapsed-${row.start}`} className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => toggle(row.start)}
              className="grid grid-cols-[24px_1fr] gap-2 rounded px-0.5 text-left font-mono text-[10px] text-white/50 hover:bg-white/5 hover:text-white/70"
            >
              <span className="text-white/50">…</span>
              <span>
                {open ? "Hide" : "Show"} {row.count} system frames
              </span>
            </button>
            {open &&
              row.frames.map((item) => (
                <FrameRow key={item.index} index={item.index} frame={item.frame} />
              ))}
          </li>
        );
      })}
    </ol>
  );
}



function emptyTailReason(source: CrashOccurrence["logTailSource"]): string {
  if (source === "buffer-rolled-past") return "The retained device logs do not cover this crash. Keep the Crashes panel open to collect logs for the next one.";
  if (source === "no-app-lines") return "The app logged nothing in the lines before this crash.";
  return "No device logs for this crash.";
}

export function CrashDetailModal({
  record,
  occurrence,
  report,
  reportError,
  now,
  pendingIndex,
  loadError,
  onSelectOccurrence,
  onStepOccurrence,
  onClose,
}: {
  record: CrashSummary;
  occurrence: SelectedOccurrence;
  report: string | null;
  reportError: string | null;
  now: number;
  pendingIndex: number;
  loadError: string | null;
  onSelectOccurrence: (index: number) => void;
  onStepOccurrence: (delta: number) => boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"stack" | "log">("stack");
  const [copied, copy] = useCopy();
  const panelRef = useRef<HTMLDivElement>(null);
  const {
    width,
    onPointerDown: onResizePointerDown,
    onKeyDown: onResizeKeyDown,
  } = useResizableCenteredWidth(
    "serve-sim:crash-detail-width",
    CRASH_DETAIL_DEFAULT_WIDTH,
    CRASH_DETAIL_MIN_WIDTH,
    CRASH_DETAIL_MAX_WIDTH,
  );
  const ago = formatCrashAgo(occurrence.capturedAtMs, now);
  const clock = formatOccurrenceClock(occurrence.capturedAtMs, occurrence.capturedAt ?? "unknown time");
  const frames = occurrence.frames;

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const root = panelRef.current;
        if (!root) return;
        const focusable = [
          ...root.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ),
        ];
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (occurrence.total <= 1) return;
      if (e.key === "ArrowLeft") {
        if (onStepOccurrence(-1)) e.preventDefault();
      } else if (e.key === "ArrowRight") {
        if (onStepOccurrence(1)) e.preventDefault();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, onStepOccurrence, occurrence.total]);

  const download = (): void => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([report], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = occurrence.rawPath.split("/").pop() ?? `${record.id}.ips`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Crash report"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-[80vh] flex-col rounded-[12px] bg-panel border border-white/12 shadow-[0_16px_48px_rgba(0,0,0,0.6)]"
        style={{ width, maxWidth: "calc(100vw - 3rem)" }}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize crash report"
          aria-valuemin={CRASH_DETAIL_MIN_WIDTH}
          aria-valuemax={CRASH_DETAIL_MAX_WIDTH}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onPointerDown={onResizePointerDown}
          onKeyDown={onResizeKeyDown}
          className="group absolute inset-y-0 right-0 z-10 flex w-4 translate-x-1/2 cursor-col-resize touch-none items-center justify-center outline-none"
        >
          <span className="h-8 w-1 rounded-full bg-[#48484a] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100" />
        </div>
        <header className="flex items-start justify-between gap-3 border-b border-white/8 px-4 py-3">
          <div>
            <p className="flex items-center gap-2">
              <span className="font-mono text-[13px] text-red-300">
                {record.signal ?? record.exceptionType}
              </span>
              <span className="text-[13px] text-white/80">{record.appName}</span>
            </p>
            <p className="mt-0.5 text-[11px] text-white/40" title={clock}>
              {ago !== "" ? ago : clock}
              {occurrence.pid !== null && <span className="text-white/25"> · pid {occurrence.pid}</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={download}
              disabled={!report}
              className="rounded-md border border-white/12 px-2 py-1 text-[11px] text-white/70 hover:bg-white/8 disabled:opacity-40"
            >
              Download .ips
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close crash report"
              className="flex items-center rounded-md px-2 py-1 text-[#8e8e93] hover:bg-white/8 hover:text-white"
            >
              <X size={14} strokeWidth={1.75} />
            </button>
          </div>
        </header>

        {occurrence.total > 1 && (
          <div className="flex flex-col gap-1.5 border-b border-white/8 px-4 py-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={pendingIndex <= 0}
                onClick={() => onStepOccurrence(-1)}
                className="rounded-md border border-white/12 px-2 py-1 text-[11px] text-white/70 hover:bg-white/8 disabled:opacity-30"
              >
                ← Older
              </button>
              <div
                role="group"
                aria-label="Earlier crashes"
                aria-busy={pendingIndex !== occurrence.index}
                className="flex flex-1 items-center justify-center gap-1"
              >
                {Array.from({ length: occurrence.total }, (_, index) => {
                  const current =
                    index === occurrence.index &&
                    record.occurrenceTimes[index]?.key === occurrence.key;
                  const pending = index === pendingIndex && !current;
                  return (
                    <button
                      key={index}
                      type="button"
                      aria-current={current ? "true" : undefined}
                      aria-label={`Crash ${index + 1} of ${occurrence.total}`}
                      title={formatOccurrenceClock(
                        record.occurrenceTimes[index]?.capturedAtMs ?? null,
                        record.occurrenceTimes[index]?.capturedAt ?? ""
                      )}
                      onClick={() => onSelectOccurrence(index)}
                      className={`flex h-7 w-7 items-center justify-center rounded-full ${
                        current ? "" : "hover:bg-white/10"
                      }`}
                    >
                      <span
                        className={`rounded-full ${
                          current
                            ? "h-1.5 w-3 bg-red-300"
                            : pending
                              ? "h-1.5 w-1.5 bg-white/50 ring-1 ring-white/40"
                              : "h-1.5 w-1.5 bg-white/40"
                        }`}
                      />
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                disabled={pendingIndex >= occurrence.total - 1}
                onClick={() => onStepOccurrence(1)}
                className="rounded-md border border-white/12 px-2 py-1 text-[11px] text-white/70 hover:bg-white/8 disabled:opacity-30"
              >
                Newer →
              </button>
            </div>
            {record.count > occurrence.total && (
              <p className="text-center font-mono text-[11px] text-white/25">
                last {occurrence.total} of {record.count}
              </p>
            )}
          </div>
        )}

        {loadError && (
          <p className="border-b border-white/8 px-4 py-2 text-center text-[11px] text-amber-300/80">
            {loadError}
          </p>
        )}

        <div className="flex flex-col gap-2 border-b border-white/8 px-4 py-3">
          <Row label="Bundle" value={record.bundleId ?? "unknown"} />
          <Row label="Exception" value={`${record.exceptionType ?? "?"} · ${record.terminationIndicator ?? "?"}`} />
          <Row label="Thread" value={occurrence.faultingQueue ?? "unknown queue"} />
          <Row label="Version" value={`${occurrence.appVersion ?? "?"} (${occurrence.buildVersion ?? "?"})`} />
          <Row label="Report" value={occurrence.rawPath} />
        </div>

        <nav className="flex items-center gap-1 px-4 pt-3">
          {(["stack", "log"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded-md px-2 py-1 text-[11px] ${
                tab === id ? "bg-white/10 text-white/90" : "text-white/45 hover:bg-white/5"
              }`}
            >
              {id === "stack" ? `Stack (${frames.length})` : `Log tail (${occurrence.logTail.length})`}
            </button>
          ))}
          <button
            type="button"
            onClick={() =>
              copy(
                tab === "stack"
                  ? frames
                      .map(
                        (frame, index) =>
                          `${index}\t${frame.image}\t${frame.symbol ?? `+${frame.imageOffset ?? 0}`}`
                      )
                      .join("\n")
                  : occurrence.logTail.map(messageOf).join("\n")
              )
            }
            className="ml-auto rounded-md px-2 py-1 text-[11px] text-white/45 hover:bg-white/5"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </nav>

        <div className="flex-1 overflow-auto px-4 py-3">
          {reportError && <p className="mb-2 text-[11px] text-amber-300/80">{reportError}</p>}
          {tab === "stack" ? (
            <StackTrace frames={frames} />
          ) : occurrence.logTail.length === 0 ? (
            <p className="text-[11px] text-white/35">{emptyTailReason(occurrence.logTailSource)}</p>
          ) : (
            <ol className="font-mono text-[10px] leading-relaxed">
              {occurrence.logTail.map((raw, index) => {
                const last = index === occurrence.logTail.length - 1;
                const fields = parseDeviceLogJson(raw);
                const time = fields ? formatLogClock(fields.timestamp) : "";
                const bad = fields?.level === "error" || fields?.level === "fault";
                return (
                  <li
                    key={index}
                    className={`grid grid-cols-[34px_5.5rem_1fr] items-start gap-2 px-1 ${
                      last
                        ? "rounded bg-red-400/10 text-white/80"
                        : bad
                          ? "text-red-300/80"
                          : "text-white/55"
                    }`}
                  >
                    <span className="select-none text-right text-white/25 tabular-nums">
                      {index + 1}
                    </span>
                    <span className="tabular-nums text-white/30">{time || "\u00a0"}</span>
                    <span className="whitespace-pre-wrap break-all">
                      {fields?.message ?? raw}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
