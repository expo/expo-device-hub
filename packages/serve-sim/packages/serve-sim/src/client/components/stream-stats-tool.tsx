import type { ReactNode } from "react";
import { Download } from "lucide-react";

import { triggerBrowserDownload } from "../utils/screenshot-capture";
import type { CaptureCounts, SenderStreamStats } from "../../webrtc-sender-stats";
import type { StreamStats } from "../utils/webrtc-stats";
import { Sparkline } from "./sparkline";

export function StreamStatsBody({
  stats,
  history,
  faults,
  sender,
  capture,
  requestedFps,
  stale,
  action,
}: {
  stats: StreamStats;
  history: StreamStats[];
  faults: string[];
  sender?: SenderStreamStats | null;
  capture?: CaptureCounts | null;
  requestedFps?: number;
  stale?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-2 border-b border-white/10 pb-2 ${stale ? "opacity-50" : ""}`}>
      <Graph
        label="Frame rate"
        value={fps(stats.fps)}
        hint={requestedFps ? `of ${requestedFps}` : undefined}
        values={measured(history, (sample) => sample.fps)}
        max={requestedFps}
        className="text-emerald-400"
      />
      <Graph
        label="Bitrate"
        value={bitrate(stats.kbps)}
        values={measured(history, (sample) => sample.kbps)}
        className="text-sky-400"
      />

      <div className="flex items-start justify-between gap-2">
        {stale ? (
          <div className="text-[11px] text-warning">No samples in the last few seconds</div>
        ) : faults.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {faults.map((fault) => (
              <div key={fault} className="text-[11px] text-warning" data-stream-fault={fault}>
                {fault}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-white/30">
            {measurable(stats) ? "No drops, freezes or loss in this window" : "Measuring…"}
          </div>
        )}
        {action}
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 border-t border-white/10 pt-1.5">
        <Cell label="RTT" value={ms(stats.roundTripMs, 0)} />
        <Cell label="Jitter" value={ms(stats.jitterMs, 1)} />
        <Cell label="Jitter buffer" value={ms(stats.jitterBufferMs, 0)} />
        <Cell
          label="Resolution"
          value={stats.width === null || stats.height === null
            ? DASH
            : `${stats.width}x${stats.height}`}
        />
        {stats.path !== "unknown" && (
          <Cell label="ICE route" value={stats.path === "relay" ? "Via relay" : "Direct"} />
        )}
      </div>

      {sender && <SenderRows sender={sender} />}
      {capture && <CaptureRows capture={capture} />}
    </div>
  );
}

/** The encoder's own view. None of this is visible to a receive-only browser. */
function SenderRows({ sender }: { sender: SenderStreamStats }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-white/10 pt-1.5">
      <div className="pb-0.5 text-[10px] uppercase tracking-[0.08em] text-white/30">Encoder</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        <Cell label="Encode FPS" value={fps(sender.reportedFps)} />
        <Cell label="Target" value={bitrate(sender.targetKbps)} />
        <Cell label="Pacer FPS" value={fps(sender.sourceFps)} />
        <Cell label="Encode" value={ms(sender.encodeMsPerFrame, 1)} hint="/frame" />
        <Cell label="Frames sent" value={compact(sender.framesSent)} />
        <Cell label="Loss" value={percent(sender.lossRatio)} hint="total" />
      </div>
    </div>
  );
}

function CaptureRows({ capture }: { capture: CaptureCounts }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-white/10 pt-1.5">
      <div className="pb-0.5 text-[10px] uppercase tracking-[0.08em] text-white/30">Capture</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        <Cell label="Screen frames" value={compact(capture.screenFrames)} />
        <Cell label="Idle frames" value={compact(capture.idleFrames)} />
        <Cell label="Capture deliveries" value={compact(capture.offeredFrames)} />
        <Cell label="Pacer submissions" value={compact(capture.forwardedFrames)} />
      </div>
    </div>
  );
}

/** These are lifetime counters and reach millions, so a fixed-width cell needs them short. */
function compact(value: number | null): string {
  if (value === null) return DASH;
  const magnitude = Math.abs(value);
  if (magnitude < 1_000) return String(value);
  if (magnitude < 999_950) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

function percent(ratio: number | null): string {
  return ratio === null ? DASH : `${(ratio * 100).toFixed(1)}%`;
}

const DASH = "—";

/** Only the windows that produced a reading, so a gap is a gap rather than a drop to zero. */
function measured(history: StreamStats[], pick: (sample: StreamStats) => number | null): number[] {
  const values: number[] = [];
  for (const sample of history) {
    const value = pick(sample);
    if (value !== null) values.push(value);
  }
  return values;
}

/** Whether this sample came from a usable window. Nothing measured is not the same as nothing wrong. */
function measurable(stats: StreamStats): boolean {
  return stats.droppedInWindow !== null;
}

/** For the collapsed section header. */
export function summariseStream(stats: StreamStats): string | null {
  if (stats.fps === null) return null;
  return `${fps(stats.fps)} · ${bitrate(stats.kbps)}`;
}

/** Only faults, so a healthy stream stays quiet. */
export function describeFaults(
  stats: StreamStats,
  sender?: SenderStreamStats | null,
): string[] {
  const faults: string[] = [];
  if (stats.freezesInWindow) {
    const seconds = stats.freezeMsInWindow ? ` (${(stats.freezeMsInWindow / 1000).toFixed(1)}s)` : "";
    faults.push(`${stats.freezesInWindow} freeze${stats.freezesInWindow === 1 ? "" : "s"}${seconds}`);
  }
  if (stats.droppedInWindow) faults.push(`${stats.droppedInWindow} frames dropped`);
  if (stats.lossRatio !== null && stats.lossRatio > 0.02) {
    faults.push(`${(stats.lossRatio * 100).toFixed(1)}% packet loss`);
  }
  const limited = limitation(sender?.qualityLimitationReason);
  if (limited !== null) faults.push(limited);
  return faults;
}

/** libwebrtc's reason codes read as jargon, and "limited by bandwidth" blames the wrong side. */
function limitation(reason: string | null | undefined): string | null {
  switch (reason) {
    case "cpu":
      return "Encoder cannot keep up (CPU)";
    case "bandwidth":
      return "Bitrate reduced by the network";
    case undefined:
    case null:
    case "none":
      return null;
    default:
      return "Encoder holding back (reason unknown)";
  }
}

/** One decimal under 10, so a stream limping at 0.4 fps does not read as 0. */
function fps(value: number | null): string {
  if (value === null) return DASH;
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)} fps`;
}

/** kbps below 1 Mbps, so a limping stream is not "0.00 Mbps". */
function bitrate(kbps: number | null): string {
  if (kbps === null) return DASH;
  return kbps < 1000 ? `${kbps.toFixed(0)} kbps` : `${(kbps / 1000).toFixed(2)} Mbps`;
}

function ms(value: number | null, digits: number): string {
  return value === null ? DASH : `${value.toFixed(digits)} ms`;
}

function Graph({
  label,
  value,
  hint,
  values,
  max,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  values: number[];
  max?: number;
  className: string;
}) {
  return (
    <div className="flex flex-col gap-1" data-stream-stat={label}>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-white/50">{label}</span>
        <span className="tabular-nums text-[11px]">
          {value}
          {hint && <span className="ml-1.5 text-[11px] text-white/30">{hint}</span>}
        </span>
      </div>
      <Sparkline values={values} max={max} className={className} />
    </div>
  );
}

function Cell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2" data-stream-stat={label}>
      <span className="whitespace-nowrap text-[11px] text-white/50">{label}</span>
      <span className="tabular-nums whitespace-nowrap text-[11px] text-white/90">
        {value}
        {hint && <span className="ml-1.5 text-[11px] text-white/30">{hint}</span>}
      </span>
    </div>
  );
}

export function StreamStatsSection({
  stats,
  history,
  faults,
  sender,
  capture,
  requestedFps,
  stale,
  action,
}: {
  stats: StreamStats | null;
  history: StreamStats[];
  faults: string[];
  sender?: SenderStreamStats | null;
  capture?: CaptureCounts | null;
  requestedFps?: number;
  stale?: boolean;
  action?: ReactNode;
}) {
  if (stats === null) return null;
  return (
    <StreamStatsBody
      stats={stats}
      history={history}
      faults={faults}
      sender={sender}
      capture={capture}
      requestedFps={requestedFps}
      stale={stale}
      action={action}
    />
  );
}

export function StreamStatsDownload({
  history,
  context,
}: {
  history: StreamStats[];
  context: StatsContext;
}) {
  if (history.length < 2) return null;
  return (
    <button
      type="button"
      title={`Download ${history.length} recorded samples as JSON`}
      aria-label={`Download ${history.length} recorded samples as JSON`}
      onClick={() => downloadStats(history, context)}
      className="-mt-0.5 inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-white/30 hover:bg-white/[0.06] hover:text-white/80"
    >
      <Download aria-hidden="true" className="h-3 w-3" />
    </button>
  );
}

export interface StatsContext {
  transport?: string;
  codec?: string | null;
  sender?: SenderStreamStats | null;
  capture?: CaptureCounts | null;
}

/** Serialize the recorded window so a session can be handed to someone else to read. */
export function statsToJson(history: StreamStats[], context: StatsContext = {}): string {
  return JSON.stringify(
    { recordedAt: new Date().toISOString(), ...context, samples: history },
    null,
    2,
  );
}

function downloadStats(history: StreamStats[], context: StatsContext): void {
  const url = URL.createObjectURL(
    new Blob([statsToJson(history, context)], { type: "application/json" }),
  );
  triggerBrowserDownload(url, `serve-sim-stream-stats-${timestampSlug()}.json`);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
}
