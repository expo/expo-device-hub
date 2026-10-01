/// Deciding whether a stream has stopped decoding, from the counters `getStats` reports.

/// One read a second, shared with the stats panel so nothing polls `getStats` twice.
export const PLAYBACK_STALL_POLL_MS = 1_000;
/// Polls, not wall-clock: a hidden tab's interval is throttled, so elapsed time there says
/// nothing about whether decoding stopped. Eight of them is the same eight seconds as before.
export const PLAYBACK_STALL_POLLS = 8;

export interface PlaybackProgress {
  /// Null when the browser does not report the counter, which is not the same as zero.
  decoded: number | null;
  /// Whole frames assembled from RTP. Loss keeps bytes climbing while no frame completes, so
  /// bytes would read as healthy media.
  received: number;
}

export interface PlaybackStallState {
  decoded: number | null;
  /// As of the poll that began the frozen run, so bursty delivery still counts as arriving.
  received: number;
  stalledPolls: number;
}

export const initialPlaybackStallState: PlaybackStallState = {
  decoded: null,
  received: 0,
  stalledPolls: 0,
};

/// Whether decoding stopped while media keeps arriving. Anything ambiguous restarts the run
/// rather than accusing the decoder.
export function nextPlaybackStallState(
  state: PlaybackStallState,
  progress: PlaybackProgress,
): { state: PlaybackStallState; stalled: boolean; mediaArriving: boolean } {
  const mediaArriving = progress.received > state.received;
  const settled = (stalledPolls: number) => ({
    state: { decoded: progress.decoded, received: progress.received, stalledPolls },
    stalled: false,
    mediaArriving,
  });
  if (progress.decoded === null || state.decoded === null) return settled(0);
  if (progress.decoded !== state.decoded) return settled(0);
  const stalledPolls = state.stalledPolls + 1;
  return {
    state: { decoded: progress.decoded, received: state.received, stalledPolls },
    stalled: stalledPolls >= PLAYBACK_STALL_POLLS,
    mediaArriving,
  };
}

export interface InboundReport {
  id: string;
  framesReceived: number;
}

/// Which inbound report to judge when a connection carries more than one. Following one by id
/// alone pins a report for an SSRC that has gone away, so a stalled pin yields to a live one.
export function selectInboundReport<T extends InboundReport>(
  reports: T[],
  previous: InboundReport | null,
  previousReports: readonly InboundReport[] = [],
): T | null {
  if (reports.length === 0) return null;
  const liveliest = reports.reduce((a, b) => (b.framesReceived > a.framesReceived ? b : a));
  if (!previous) return liveliest;
  const pinned = reports.find((r) => r.id === previous.id);
  if (!pinned) return liveliest;
  if (pinned.framesReceived > previous.framesReceived) return pinned;
  let advancingSibling: T | null = null;
  let largestIncrease = 0;
  for (const report of reports) {
    if (report.id === pinned.id) continue;
    const earlier = previousReports.find((r) => r.id === report.id);
    const increase = earlier ? report.framesReceived - earlier.framesReceived : 0;
    if (increase > largestIncrease) {
      advancingSibling = report;
      largestIncrease = increase;
    }
  }
  if (advancingSibling) return advancingSibling;
  return liveliest.framesReceived > pinned.framesReceived ? liveliest : pinned;
}
