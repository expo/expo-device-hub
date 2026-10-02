/** Receiver polling is shared with the stats panel. */
export const PLAYBACK_STALL_POLL_MS = 1_000;
/** Count active polls; hidden tabs can throttle timers. */
export const PLAYBACK_STALL_POLLS = 8;

export interface PlaybackProgress {
  /** Null when the browser does not report decoded frames. */
  decoded: number | null;
  /** Complete RTP frames; byte growth alone does not prove frame delivery. */
  received: number;
}

export interface PlaybackStallState {
  decoded: number | null;
  /** Frozen-run baseline, retained until decoding progresses. */
  received: number;
  stalledPolls: number;
}

export const initialPlaybackStallState: PlaybackStallState = {
  decoded: null,
  received: 0,
  stalledPolls: 0,
};

/** Compare decode progress, retaining the received-frame baseline during a stall. */
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

/** Follow the active SSRC, yielding to an advancing sibling when the pinned report stops. */
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
  // Lifetime totals cannot make a report live again once history shows it is idle.
  if (previousReports.length > 0) return pinned;
  return liveliest.framesReceived > pinned.framesReceived ? liveliest : pinned;
}
