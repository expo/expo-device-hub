import { startExclusivePoll } from "../utils/exclusive-poll";
import { playbackStallAction, webRtcFailureDisposition } from "../webrtc-failure-policy";
import {
  initialPlaybackStallState,
  nextPlaybackStallState,
  PLAYBACK_STALL_POLL_MS,
  PLAYBACK_STALL_POLLS,
  selectInboundReport,
} from "../webrtc-playback-stall";

/// A read always settles within its deadline, and the gap limit clears a deadline plus a poll.
const READ_DEADLINE_MS = PLAYBACK_STALL_POLL_MS * 2;
const POLL_GAP_LIMIT_MS = PLAYBACK_STALL_POLL_MS * PLAYBACK_STALL_POLLS;

export interface InboundVideo {
  id: string;
  framesReceived: number;
  framesDecoded: number | null;
}

/// Every inbound video report. Which one to judge is `selectInboundReport`'s decision.
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

/// A hung `getStats` cannot be cancelled, so it stays the connection's one read until it
/// settles. A deadline only stops the waiting.
const readsInFlight = new WeakMap<RTCPeerConnection, Promise<RTCStatsReport | null>>();

function readStats(pc: RTCPeerConnection): Promise<RTCStatsReport | null> {
  const inFlight = readsInFlight.get(pc);
  if (inFlight) return inFlight;
  const read = pc.getStats().catch(() => null);
  readsInFlight.set(pc, read);
  void read.then(() => readsInFlight.delete(pc));
  return read;
}

/// One read, shared by the stall watchdog and the stats panel. Null means "could not
/// measure", which restarts the stall run rather than accusing the decoder.
export async function readStatsBeforeDeadline(
  pc: RTCPeerConnection | null,
  deadlineMs: number,
): Promise<RTCStatsReport | null> {
  if (!pc) return null;
  let timeout: number | undefined;
  try {
    return await Promise.race([
      readStats(pc),
      new Promise<null>((resolve) => {
        timeout = window.setTimeout(() => resolve(null), deadlineMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

export interface PlaybackStallWatchdog {
  stop: () => void;
  /// End the current run without a verdict. Anything that makes the counters incomparable.
  invalidate: () => void;
}

/**
 * Past the first paint a decoder can still give up, leaving the session connected, receiving,
 * and decoding nothing. This watches the decode counters for exactly that.
 */
export function startPlaybackStallWatchdog({
  peer,
  readable,
  judgeable,
  publish,
  reconnectedAt,
  failCodec,
  retryTransport,
}: {
  peer: () => RTCPeerConnection | null;
  /// Worth a `getStats` at all. A hidden tab's decoder may stop, which looks like a dead one.
  readable: () => boolean;
  /// Whether a frozen decoder would mean anything yet. The panel is fed either way.
  judgeable: () => boolean;
  publish: (report: RTCStatsReport, at: number) => void;
  /// When this codec was last reconnected for a stall.
  reconnectedAt: { current: number | null };
  failCodec: () => void;
  retryTransport: (message: string) => void;
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

  const stop = startExclusivePoll(async () => {
    if (!readable()) {
      invalidate();
      return;
    }
    const reading = generation;
    const pc = peer();
    const report = await readStatsBeforeDeadline(pc, READ_DEADLINE_MS);
    // Stamped on arrival, because that is when the counters in it were read. Stamping the
    // call instead puts the read's own latency into the panel's rate divisor.
    // A read the replaced peer finishes late would open the next one's history.
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

  return { stop, invalidate };
}
