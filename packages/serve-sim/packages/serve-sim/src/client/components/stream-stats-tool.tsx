import { useId, useState, type ReactNode } from "react";
import { Download } from "lucide-react";

import { triggerBrowserDownload } from "../utils/screenshot-capture";
import type { CaptureCounts, EncoderIdentity, SenderStreamStats } from "../../webrtc-sender-stats";
import type { CaptureWindow } from "../utils/capture-window";
import type { StreamStats } from "../utils/webrtc-stats";
import { Sparkline } from "./sparkline";
import { describeDownscale, encoderLabel, qualityLimitation } from "./stream-stats-labels";

export function StreamStatsBody({
  stats,
  history,
  faults,
  sender,
  capture,
  encoder,
  requestedFps,
  selectedMaxDimension,
  stale,
  action,
}: {
  stats: StreamStats;
  history: StreamStats[];
  faults: string[];
  sender?: SenderStreamStats | null;
  capture?: CaptureWindow | null;
  encoder?: EncoderIdentity | null;
  requestedFps?: number;
  selectedMaxDimension?: number;
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

      <div className="flex items-start justify-end gap-2">{action}</div>

      {/* Full rows, like the graphs: the frame gap's spread does not fit half the panel. */}
      <div className="flex flex-col gap-y-0.5 border-t border-white/10 pt-1.5">
        <Cell label="Frame gap" value={frameGap(stats.frameGapMs, stats.pacingDeviationMs)} />
        <Cell
          label="Resolution"
          value={stats.width === null || stats.height === null
            ? DASH
            : `${stats.width}x${stats.height}`}
        />
      </div>

      <Diagnostics
        stats={stats}
        sender={sender}
        capture={capture}
        encoder={encoder}
        selectedMaxDimension={selectedMaxDimension}
        faults={faults}
        stale={stale}
      />
    </div>
  );
}

/** Everything past "is it smooth". Collapsed, because most sessions never ask. */
function Diagnostics({
  stats,
  sender,
  capture,
  encoder,
  selectedMaxDimension,
  faults,
  stale,
}: {
  stats: StreamStats;
  sender?: SenderStreamStats | null;
  capture?: CaptureWindow | null;
  encoder?: EncoderIdentity | null;
  selectedMaxDimension?: number;
  faults: string[];
  stale?: boolean;
}) {
  const downscale = sender ? describeDownscale(selectedMaxDimension ?? 0, sender) : null;
  return (
    <details className="border-t border-white/10 pt-1.5">
      <summary className="-my-1 flex cursor-pointer list-none items-center gap-1 py-1 text-[10px] uppercase tracking-[0.08em] text-white/30 hover:text-white/60">
        <span className="transition-transform [details[open]_&]:rotate-90">&rsaquo;</span>
        Diagnostics
      </summary>

      <div className="pt-1.5">
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
          <div className="text-[11px] text-white/30">{healthLine(stats)}</div>
        )}
      </div>

      <Group label="Network">
        <Cell label="RTT" value={ms(stats.roundTripMs, 0)} />
        <Cell label="Jitter" value={ms(stats.jitterMs, 1)} />
        <Cell label="Jitter buffer" value={ms(stats.jitterBufferMs, 0)} />
        <Cell label="Decode" value={ms(stats.decodeMsPerFrame, 1)} />
        {stats.path !== "unknown" && (
          <Cell label="ICE route" value={stats.path === "relay" ? "Via relay" : "Direct"} />
        )}
      </Group>

      {sender && (
        <Group label="Encoder">
          <Cell label="Encode FPS" value={fps(sender.reportedFps)} />
          <Cell label="Target" value={bitrate(sender.targetKbps)} />
          <Cell label="Pacer FPS" value={fps(sender.sourceFps)} />
          <Cell label="Encode" value={ms(sender.encodeMsPerFrame, 1)} />
          <Cell label="Frames sent" value={compact(sender.framesSent)} />
          <Cell label="Loss" value={percent(sender.lossRatio)} />
          {sender.codec && <Cell label="Codec" value={sender.codec.toLowerCase()} />}
          {encoder && <Cell label={encoder.probe ? "Encoder probe" : "Encoder"} value={encoderLabel(encoder)} />}
          {downscale && <Cell label="Scaled" value={downscale} />}
        </Group>
      )}

      {capture && (
        <Group label="Capture">
          <Cell label="Screen frames" value={perSecond(capture.screenFps)} />
          <Cell label="Idle frames" value={perSecond(capture.idleFps)} />
          <Cell label="Capture deliveries" value={perSecond(capture.deliveredFps)} />
          <Cell label="Pacer submissions" value={perSecond(capture.submittedFps)} />
          <Cell label="Stalls" value={compact(capture.stalls)} />
          <Cell label="Stall time" value={duration(capture.stallSumMs)} />
          <Cell label="Capture interval" value={ms(capture.intervalMs, 1)} />
          <Cell label="Surface pick" value={ms(capture.pickMs, 2)} />
          <Cell label="CPU fallbacks" value={compact(capture.cpuFallbacks)} />
          <Cell label="Pump restarts" value={compact(capture.pumpRestarts)} />
        </Group>
      )}
    </details>
  );
}

const WINDOW = "Last second";
const NOW = "Now";
const PER_FRAME = "Average per frame, this session";
const PER_FRAME_WINDOW = "Average per frame, last second";
const SESSION = "Since the session started";

type Scope = typeof WINDOW | typeof NOW | typeof PER_FRAME | typeof PER_FRAME_WINDOW
  | typeof SESSION;

const HELP: Record<string, { meaning: string; scope: Scope }> = {
  "Frame rate": { meaning: "Frames the browser painted.", scope: WINDOW },
  Bitrate: { meaning: "Rate of video data arriving.", scope: WINDOW },
  "Frame gap": {
    meaning: "Time between frames. The number after the plus-minus is how much that time varies, so a small one means smooth playback.",
    scope: WINDOW,
  },
  Resolution: { meaning: "Size of the video the browser receives. Not the device screen.", scope: NOW },
  RTT: { meaning: "Round trip time to the simulator. A high value delays your taps, not the picture.", scope: NOW },
  Jitter: { meaning: "Variation in packet arrival time.", scope: NOW },
  "Jitter buffer": { meaning: "How long the browser holds packets before it decodes them.", scope: NOW },
  Decode: { meaning: "Time the browser spends decoding one frame.", scope: PER_FRAME_WINDOW },
  "ICE route": {
    meaning: "Direct is peer to peer. Via relay goes through a TURN server and adds latency.",
    scope: NOW,
  },
  "Encode FPS": { meaning: "Frames the encoder produced.", scope: WINDOW },
  Target: { meaning: "Bitrate the encoder aims for. It lowers this when the network is slow.", scope: NOW },
  "Pacer FPS": { meaning: "Frames the pacer handed to the encoder. The pacer is the stage between capture and the encoder that holds the send cadence.", scope: WINDOW },
  Encode: { meaning: "Time the encoder spends on one frame.", scope: PER_FRAME },
  "Frames sent": { meaning: "Frames the encoder put on the wire, repeats included.", scope: SESSION },
  Loss: { meaning: "Packets lost on the way to the browser.", scope: SESSION },
  Codec: { meaning: "Codec negotiated for this live sender.", scope: NOW },
  Encoder: { meaning: "Encoder implementation and whether it is using hardware or the CPU.", scope: NOW },
  "Encoder probe": {
    meaning: "The H.264 encoder a test encode on this machine used, and whether it ran on hardware. The live encoder does not report itself, so this is what the machine offers, not this stream.",
    scope: NOW,
  },
  Scaled: { meaning: "Encoded long edge compared with the selected size, plus the limiting cause when known.", scope: NOW },

  "Screen frames": { meaning: "New images the simulator produced.", scope: WINDOW },
  "Idle frames": { meaning: "Frames sent by the 5 per second idle refresh, because nothing had changed for 200 ms.", scope: WINDOW },
  "Capture deliveries": { meaning: "Frames capture handed to the pacer.", scope: WINDOW },
  "Pacer submissions": {
    meaning: "Frames the pacer handed to the encoder. If this is higher than capture deliveries, the pacer is repeating the last frame.",
    scope: WINDOW,
  },
  Stalls: { meaning: "Times the capture loop went over 100 ms without running. It measures scheduling, not whether the screen changed.", scope: SESSION },
  "Stall time": { meaning: "Total time spent in those stalls.", scope: SESSION },
  "Capture interval": { meaning: "Average time between capture attempts. The timer and the simulator\u2019s own frame callback both count.", scope: WINDOW },
  "Surface pick": {
    meaning: "Time spent choosing which framebuffer to capture. It climbs while the compositor swaps surfaces during a transition.",
    scope: WINDOW,
  },
  "CPU fallbacks": { meaning: "Frames copied on the CPU because the GPU transfer failed.", scope: SESSION },
  "Pump restarts": {
    meaning: "Times the WebRTC frame pump was restarted after its timer stopped ticking.",
    scope: SESSION,
  },
};

/** The wrapper cannot clip, so the truncation sits on an inner span rather than on the anchor. */
function Label({ label, className }: { label: string; className: string }) {
  const help = HELP[label];
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!help) return <span className={className}>{label}</span>;
  return (
    <span
      className="relative min-w-0"
      tabIndex={0}
      aria-describedby={id}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span className={`block cursor-help decoration-dotted underline-offset-2 hover:underline ${className}`}>
        {label}
      </span>
      <span
        id={id}
        role="tooltip"
        className={`pointer-events-none absolute left-0 top-full z-50 mt-1 flex w-[190px] flex-col gap-1 rounded-md border border-white/10 bg-[#181818] p-2 text-[11px] leading-snug shadow-lg transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
      >
        <span className="text-white/90">{label}</span>
        <span className="text-white/60">{help.meaning}</span>
        <span className="text-white/35">{help.scope}</span>
      </span>
    </span>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pt-1.5">
      <div className="pb-0.5 text-[10px] uppercase tracking-[0.08em] text-white/25">{label}</div>
      {/* The right column's tooltips open leftward, or they run off the panel. */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 [&>:nth-child(even)_[role=tooltip]]:left-auto [&>:nth-child(even)_[role=tooltip]]:right-0">
        {children}
      </div>
    </div>
  );
}

/** Stall totals reach seconds, where a millisecond figure stops being readable. */
function duration(value: number | null): string {
  if (value === null) return DASH;
  return value < 1000 ? ms(value, 0) : `${(value / 1000).toFixed(1)} s`;
}

/** The mean alone hides a stutter and the spread alone has nothing to sit against. */
function frameGap(mean: number | null, deviation: number | null): string {
  if (mean === null) return DASH;
  if (deviation === null) return ms(mean, 1);
  return `${ms(mean, 1)} ± ${deviation.toFixed(1)}`;
}

/** One decimal under 10, so a capture limping at 4 frames a second is not "4/s" against a 60/s pacer. */
function perSecond(value: number | null): string {
  if (value === null) return DASH;
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)}/s`;
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

/** Nothing measured is not the same as nothing wrong, so an unusable window says so. */
function healthLine(stats: StreamStats): string {
  return stats.droppedInWindow === null ? "Measuring…" : "No drops, freezes or loss in this window";
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

function limitation(reason: string | null | undefined): string | null {
  return qualityLimitation(reason)?.long ?? null;
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
        <Label label={label} className="text-[11px] text-white/50" />
        <span data-stream-value className="tabular-nums text-[11px]">
          {value}
          {hint && <span className="ml-1.5 text-[11px] text-white/30">{hint}</span>}
        </span>
      </div>
      <Sparkline values={values} max={max} className={className} />
    </div>
  );
}

/** A value too wide to sit beside its label drops below it, so neither one is cut off. */
function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2"
      data-stream-stat={label}
    >
      <Label label={label} className="min-w-0 truncate text-[11px] text-white/50" />
      <span data-stream-value className="ml-auto min-w-0 text-right tabular-nums text-[11px] text-white/90">
        {value}
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
  encoder,
  requestedFps,
  selectedMaxDimension,
  stale,
  action,
}: {
  stats: StreamStats | null;
  history: StreamStats[];
  faults: string[];
  sender?: SenderStreamStats | null;
  capture?: CaptureWindow | null;
  encoder?: EncoderIdentity | null;
  requestedFps?: number;
  selectedMaxDimension?: number;
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
      encoder={encoder}
      requestedFps={requestedFps}
      selectedMaxDimension={selectedMaxDimension}
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
  encoder?: EncoderIdentity | null;
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
