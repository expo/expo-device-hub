import { useEffect, useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useCrashDetail } from "../hooks/use-crash-detail";
import {
  applyCrashFrame,
  EMPTY_CRASH_LIST,
  type CrashListState,
} from "../utils/crash-stream";
import { crashStreamUrl, formatCrashAgo } from "../utils/crash-format";
import { watchCrashes } from "../utils/watch-crashes";
import { simEndpoint } from "../utils/sim-endpoint";
import { CollapsibleSection } from "./collapsible-section";
import { CrashDetailModal } from "./crash-detail-modal";
import { Tooltip } from "./tooltip";

export function CrashTool({ udid, crashesEndpoint }: { udid: string; crashesEndpoint?: string }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<CrashListState>(EMPTY_CRASH_LIST);
  const [now, setNow] = useState(() => Date.now());
  const [streamErrored, setStreamErrored] = useState(false);

  const path = useMemo(
    () => crashesEndpoint ?? `${simEndpoint("crashes")}?device=${encodeURIComponent(udid)}`,
    [crashesEndpoint, udid]
  );
  // Watching costs a device log tail, so ask for one only while the section is showing crashes.
  const streamPath = crashStreamUrl(path, open);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    setList(EMPTY_CRASH_LIST);
    return watchCrashes(
      streamPath,
      (frame) => {
        setStreamErrored(false);
        setList((prev) => applyCrashFrame(prev, frame));
      },
      () => setStreamErrored(true),
    );
  }, [streamPath]);

  const {
    detail,
    pendingIndex,
    error: detailError,
    load: loadDetail,
    select: selectOccurrence,
    step: stepOccurrence,
    close: closeDetail,
  } = useCrashDetail(path, list.crashes);
  const crashes = list.crashes;
  const evicted = list.ready && detail !== null && !crashes.some((crash) => crash.id === detail.record.id);
  const unavailable = list.meta?.status === "unavailable";
  const streamWarning = unavailable
    ? (list.meta?.statusError ?? "Crash reports are unavailable")
    : streamErrored
      ? "The crash stream disconnected"
      : null;
  const warning = streamWarning ?? (detail ? null : detailError);

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      data-crashes=""
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none">
            Crashes
          </span>
          <span className="justify-self-end inline-flex items-center gap-1.5">
            {warning && (
              <Tooltip label={warning} align="right">
                <span role="status" className="inline-flex items-center">
                  <TriangleAlert aria-hidden="true" className="size-3.5 text-amber-400" />
                  <span className="sr-only">{warning}</span>
                </span>
              </Tooltip>
            )}
            <span
              className={`font-mono text-[10px] ${
                crashes.length > 0 ? "text-red-300" : "text-white/45"
              }`}
            >
              {crashes.length}
            </span>
          </span>
        </>
      }
    >
      {crashes.length === 0 ? (
        <p role="status" aria-live="polite" className="text-[11px] text-white/40">
          {unavailable ? "Crash reports unavailable" : "No crashes yet"}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {crashes.map((crash) => (
            <li key={crash.id}>
              <button
                type="button"
                onClick={() => {
                  if (detail) return;
                  void loadDetail(crash.id);
                }}
                className="w-full px-1 py-1 text-left hover:bg-white/[0.04]"
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-red-300">
                    {crash.signal ?? crash.exceptionType ?? "crash"}
                  </span>
                  {crash.count > 1 && (
                    <span className="font-mono text-[10px] text-white/45">×{crash.count}</span>
                  )}
                  <span className="truncate font-mono text-[11px] text-white/45">{crash.appName}</span>
                  <span
                    title={
                      crash.capturedAtMs === null
                        ? (crash.capturedAt ?? "")
                        : new Date(crash.capturedAtMs).toLocaleTimeString()
                    }
                    className="ml-auto shrink-0 font-mono text-[10px] text-white/35"
                  >
                    {formatCrashAgo(crash.capturedAtMs, now)}
                  </span>
                </span>
                <span className="mt-0.5 block truncate font-mono text-[10px] text-white/40">
                  {crash.culpritFrame ?? crash.terminationIndicator ?? "No stack frames"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {detail && (
        <CrashDetailModal
          record={detail.record}
          occurrence={detail.occurrence}
          report={detail.report}
          reportError={detail.reportError}
          now={now}
          pendingIndex={pendingIndex ?? detail.occurrence.index}
          loadError={
            evicted
              ? "This crash aged out of the device list. Showing the last copy read."
              : (detailError ?? streamWarning)
          }
          onSelectOccurrence={selectOccurrence}
          onStepOccurrence={stepOccurrence}
          onClose={closeDetail}
        />
      )}
    </CollapsibleSection>
  );
}
