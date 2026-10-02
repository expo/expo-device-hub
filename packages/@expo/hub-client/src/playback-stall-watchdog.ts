import { readStatsBeforeDeadline } from "./bounded-webrtc-stats.js";
import { startExclusivePoll } from "./exclusive-poll.js";
import { playbackStallAction, webRtcFailureDisposition } from "./webrtc-fallback.js";
import {
  initialPlaybackStallState,
  nextPlaybackStallState,
  PLAYBACK_STALL_POLL_MS,
  PLAYBACK_STALL_POLLS,
  selectInboundReport,
} from "./webrtc-playback-stall.js";

const READ_DEADLINE_MS = PLAYBACK_STALL_POLL_MS * 2;
const POLL_GAP_LIMIT_MS = PLAYBACK_STALL_POLL_MS * PLAYBACK_STALL_POLLS;

export interface InboundVideo {
  id: string;
  framesReceived: number;
  framesDecoded: number | null;
}

/** Read video counters before selecting the active report. */
export function parseInboundVideo(report: RTCStatsReport): InboundVideo[] {
  const reports: InboundVideo[] = [];
  report.forEach((entry) => {
    if (entry.type !== "inbound-rtp") return;
    const video = entry as RTCInboundRtpStreamStats & {
      framesReceived?: number;
      framesDecoded?: number;
    };
    if (video.kind !== "video") return;
    reports.push({
      id: video.id,
      framesReceived: video.framesReceived ?? 0,
      framesDecoded: typeof video.framesDecoded === "number" ? video.framesDecoded : null,
    });
  });
  return reports;
}

export interface PlaybackStallWatchdog {
  stop: () => void;
  /** Reset samples whose counters are no longer comparable. */
  invalidate: () => void;
}

/** Recover playback stalls after first paint while sharing receiver samples with the UI. */
export function startPlaybackStallWatchdog({
  peer,
  readable,
  judgeable,
  publish,
  reconnectedAt,
  failCodec,
  retryTransport,
  expectContinuousFrames = true,
}: {
  peer: () => RTCPeerConnection | null;
  /** Hidden tabs do not read or judge decoder progress. */
  readable: () => boolean;
  /** Judge only connected peers that have already presented a frame. */
  judgeable: () => boolean;
  publish: (report: RTCStatsReport, at: number) => void;
  /** Most recent same-codec stall retry. */
  reconnectedAt: { current: number | null };
  failCodec: () => void;
  retryTransport: (message: string) => void;
  /** Change-driven sources may stay connected without producing any new frames. */
  expectContinuousFrames?: boolean;
}): PlaybackStallWatchdog {
  let state = initialPlaybackStallState;
  let pinned: { id: string; framesReceived: number } | null = null;
  let previous: InboundVideo[] = [];
  let generation = 0;
  let lastPollAt: number | null = null;

  const invalidate = () => {
    generation += 1;
    state = initialPlaybackStallState;
    previous = [];
    lastPollAt = null;
  };

  const stopPolling = startExclusivePoll(async () => {
    if (!readable()) {
      invalidate();
      return;
    }
    const reading = generation;
    const pc = peer();
    const report = await readStatsBeforeDeadline(pc, READ_DEADLINE_MS);
    // Stamp arrivals and ignore stats completed by a replaced peer.
    if (report && readable() && peer() === pc) publish(report, Date.now());
    // Re-checked after the read: the tab can hide or the connection drop in flight.
    if (!judgeable() || !pc) {
      invalidate();
      return;
    }
    if (reading !== generation) return;
    const now = performance.now();
    // Sleep does not always raise visibilitychange, and a resumed decoder waits on a keyframe.
    if (lastPollAt !== null && now - lastPollAt > POLL_GAP_LIMIT_MS) {
      invalidate();
      lastPollAt = now;
      return;
    }
    lastPollAt = now;
    const inbound = report ? parseInboundVideo(report) : [];
    const selected = selectInboundReport(inbound, pinned, previous);
    previous = inbound;
    if (!selected) {
      state = initialPlaybackStallState;
      return;
    }
    if (selected.id !== pinned?.id) state = initialPlaybackStallState;
    pinned = { id: selected.id, framesReceived: selected.framesReceived };
    // Idle samples reset the budget; new undecoded frames retain the frozen-run baseline.
    if (!expectContinuousFrames && selected.framesReceived <= state.received) {
      state = { decoded: selected.framesDecoded, received: selected.framesReceived, stalledPolls: 0 };
      return;
    }
    const next = nextPlaybackStallState(state, {
      decoded: selected.framesDecoded,
      received: selected.framesReceived,
    });
    state = next.stalled ? initialPlaybackStallState : next.state;
    if (!next.stalled) return;
    const disposition = webRtcFailureDisposition("playback-stall", pc.connectionState, {
      mediaArriving: next.mediaArriving,
    });
    const since = reconnectedAt.current;
    const action = playbackStallAction(
      disposition,
      since === null ? null : performance.now() - since,
    );
    if (action === "fail-codec") {
      reconnectedAt.current = null;
      failCodec();
      return;
    }
    if (action !== "retry-transport") return;
    // Only a codec verdict spends the reconnect.
    if (disposition === "codec") reconnectedAt.current = performance.now();
    retryTransport("WebRTC playback stalled.");
  }, PLAYBACK_STALL_POLL_MS);

  if (typeof document !== "undefined") document.addEventListener("visibilitychange", invalidate);
  return {
    stop() {
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", invalidate);
      invalidate();
      stopPolling();
    },
    invalidate,
  };
}
