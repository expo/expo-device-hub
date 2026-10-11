import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EventLogEntry } from "../../event-log";
import { openHostEventStream } from "../../socket/client-control";
import { simEndpoint } from "../utils/sim-endpoint";
import { CollapsibleSection } from "./collapsible-section";

type EventLogPayload = {
  events?: EventLogEntry[];
  event?: EventLogEntry;
};

const MAX_EVENT_LOG_ROWS = 500;

export function EventLogTool({
  udid,
  eventsEndpoint,
}: {
  udid: string;
  eventsEndpoint?: string;
}) {
  const [open, setOpen] = useState(false);
  const path = useMemo(
    () => eventsEndpoint ?? `${simEndpoint("api/event-log/events")}?device=${encodeURIComponent(udid)}`,
    [eventsEndpoint, udid],
  );
  const [view, setView] = useState({ udid, path, events: [] as EventLogEntry[], errored: false });
  const current = useRef({ open, udid, path });
  useLayoutEffect(() => { current.current = { open, udid, path }; }, [open, udid, path]);
  const sameDevice = view.udid === udid && view.path === path;
  const errored = sameDevice && view.errored;

  useEffect(() => {
    if (!open) return;
    let active = true;
    const isCurrent = () => active && current.current.open && current.current.udid === udid && current.current.path === path;
    const stream = openHostEventStream(path);
    stream.onmessage = ({ data }) => {
      if (!isCurrent()) return;
      try {
        const payload = JSON.parse(data) as EventLogPayload;
        if (Array.isArray(payload.events)) {
          setView({ udid, path, events: payload.events.slice(-MAX_EVENT_LOG_ROWS), errored: false });
        } else if (payload.event) {
          const event = payload.event;
          setView((prev) => {
            const previous = prev.udid === udid && prev.path === path ? prev.events : [];
            const next = [...previous.filter((entry) => entry.id !== event.id), event];
            return { udid, path, events: next.slice(-MAX_EVENT_LOG_ROWS), errored: false };
          });
        }
      } catch {}
    };
    stream.onerror = () => {
      if (isCurrent()) setView((prev) => ({ udid, path, events: prev.udid === udid && prev.path === path ? prev.events : [], errored: true }));
    };
    return () => { active = false; stream.close(); };
  }, [open, path, udid]);

  const visibleEvents = useMemo(() => open && sameDevice ? view.events.slice().reverse() : [], [open, sameDevice, view.events]);

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      data-event-log=""
      summaryClassName="grid [grid-template-columns:auto_1fr_auto_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none">
            Event Log
          </span>
          <span className="justify-self-end rounded-md border border-white/8 bg-white/[0.04] px-1.5 py-[3px] text-[10px] font-mono text-white/60">
            {sameDevice ? view.events.length : 0}
          </span>
        </>
      }
    >
      {open && (visibleEvents.length === 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-center py-4 text-[12px] text-white/45"
        >
          {errored ? "Disconnected" : "No events yet"}
        </div>
      ) : (
        <div className="flex max-h-[320px] flex-col gap-1 overflow-y-auto py-0.5 [scrollbar-width:thin]" role="list">
          {visibleEvents.map((event) => (
            <EventLogRow key={event.id} event={event} />
          ))}
        </div>
      ))}
    </CollapsibleSection>
  );
}

const EventLogRow = memo(function EventLogRow({ event }: { event: EventLogEntry }) {
  const time = formatTime(event.timestamp);
  const detail = [event.source, event.kind, event.action].filter(Boolean).join(" / ");
  const message = event.msg ?? event.summary;
  const statusClass = event.status === "error"
    ? "border-[#ff453a]/50 bg-[#ff453a]/10 text-[#ffb3ad]"
    : "border-white/8 bg-white/[0.04] text-white/50";

  return (
    <div
      role="listitem"
      title={detail}
      className="grid grid-cols-[56px_1fr_auto] items-center gap-2 rounded-md px-1.5 py-1.5 text-[12px] leading-tight hover:bg-white/[0.05]"
    >
      <span className="font-mono text-[10px] text-white/45">{time}</span>
      <span className="min-w-0">
        <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-white/90">
          {message}
        </span>
        <span className="mt-0.5 block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] text-white/40">
          {detail}
        </span>
      </span>
      {event.status ? (
        <span className={`rounded-md border px-1.5 py-[3px] text-[10px] font-mono ${statusClass}`}>
          {event.status}
        </span>
      ) : null}
    </div>
  );
});

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
