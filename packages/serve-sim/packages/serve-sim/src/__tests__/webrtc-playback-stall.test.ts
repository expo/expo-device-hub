import { describe, expect, test } from "bun:test";
import { webRtcFailureDisposition } from "../client/webrtc-failure-policy";
import {
  initialPlaybackStallState,
  nextPlaybackStallState,
  PLAYBACK_STALL_POLL_MS,
  PLAYBACK_STALL_POLLS,
  selectInboundReport,
  type PlaybackProgress,
  type PlaybackStallState,
} from "../client/webrtc-playback-stall";

describe("tracking whether decoding has stopped", () => {
  const run = (samples: PlaybackProgress[]) => {
    let state: PlaybackStallState = initialPlaybackStallState;
    const stalls: boolean[] = [];
    for (const sample of samples) {
      const next = nextPlaybackStallState(state, sample);
      stalls.push(next.stalled);
      state = next.stalled ? initialPlaybackStallState : next.state;
    }
    return stalls;
  };
  const frozen = (count: number, from = 100): PlaybackProgress[] =>
    Array.from({ length: count }, (_, i) => ({ decoded: from, received: 1_000 + i * 50 }));

  test("a stream whose decode counter keeps moving never stalls", () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({ decoded: i * 30, received: i * 40 }));
    expect(run(samples)).not.toContain(true);
  });

  /// The budget itself, not just the boundary: every run above is sized off the constant, so
  /// retiming the poll would otherwise move the tests with it and go unnoticed.
  test("a stall is called after eight seconds of frozen decode", () => {
    expect(PLAYBACK_STALL_POLLS * PLAYBACK_STALL_POLL_MS).toBe(8_000);
  });

  test("reports a stall only after consecutive polls with no decoding", () => {
    const stalls = run(frozen(PLAYBACK_STALL_POLLS + 1));
    expect(stalls.slice(0, PLAYBACK_STALL_POLLS)).not.toContain(true);
    expect(stalls[PLAYBACK_STALL_POLLS]).toBe(true);
  });

  test("a long gap between polls is not itself a stall", () => {
    expect(run([{ decoded: 5, received: 10 }, { decoded: 9, received: 99 }])).not.toContain(true);
  });

  test("never stalls while the decode counter is unavailable", () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({ decoded: null, received: i * 40 }));
    expect(run(samples)).not.toContain(true);
  });

  test("a counter that goes backwards re-baselines instead of accusing the decoder", () => {
    // A replaced inbound-rtp report restarts at zero while the stream keeps running.
    const samples = [
      { decoded: 100, received: 1_000 },
      ...[0, 1, 2, 3, 4, 5, 6].map((d, i) => ({ decoded: d, received: 2_000 + i * 50 })),
    ];
    expect(run(samples)).not.toContain(true);
  });

  test("packet loss that stops whole frames is the transport, not the codec", () => {
    const lossy = nextPlaybackStallState(
      { decoded: 1_499, received: 1_499, stalledPolls: PLAYBACK_STALL_POLLS - 1 },
      { decoded: 1_499, received: 1_499 },
    );
    expect(lossy.stalled).toBe(true);
    expect(lossy.mediaArriving).toBe(false);
    expect(webRtcFailureDisposition("playback-stall", "connected", lossy)).toBe("transport");
  });

  test("distinguishes a dead decoder from a dead transport", () => {
    const arriving = nextPlaybackStallState(
      { decoded: 10, received: 100, stalledPolls: PLAYBACK_STALL_POLLS - 1 },
      { decoded: 10, received: 500 },
    );
    expect(arriving.stalled).toBe(true);
    expect(arriving.mediaArriving).toBe(true);

    const silent = nextPlaybackStallState(
      { decoded: 10, received: 100, stalledPolls: PLAYBACK_STALL_POLLS - 1 },
      { decoded: 10, received: 100 },
    );
    expect(silent.stalled).toBe(true);
    expect(silent.mediaArriving).toBe(false);
  });

  /// Frames can arrive in bursts wider than a poll, so a quiet last second does not make a
  /// run that received the whole time into a transport failure.
  test("judges media arrival over the whole frozen run, not its last poll", () => {
    const received = [100, 110, 120, 130, 140, 150, 160, 160, 160];
    let state: PlaybackStallState = initialPlaybackStallState;
    let verdict = nextPlaybackStallState(state, { decoded: 100, received: received[0]! });
    for (const count of received.slice(1)) {
      state = verdict.state;
      verdict = nextPlaybackStallState(state, { decoded: 100, received: count });
    }
    expect(verdict.stalled).toBe(true);
    expect(verdict.mediaArriving).toBe(true);
    expect(webRtcFailureDisposition("playback-stall", "connected", verdict)).toBe("codec");
  });

  test("the first sample only establishes a baseline", () => {
    expect(nextPlaybackStallState(initialPlaybackStallState, { decoded: 7, received: 1 }).stalled)
      .toBe(false);
  });
});

describe("choosing which inbound report to judge", () => {
  const r = (id: string, framesReceived: number) => ({ id, framesReceived });

  test("follows the only report there is", () => {
    expect(selectInboundReport([r("a", 10)], null)?.id).toBe("a");
  });

  test("leaves a pinned report once it stops advancing and a sibling is ahead", () => {
    const reports = [r("old", 1_000), r("new", 2_030)];
    expect(selectInboundReport(reports, { id: "old", framesReceived: 1_000 })?.id).toBe("new");
  });

  test("follows a newly advancing stream even when its lifetime count is lower", () => {
    const previousReports = [r("old", 1_000), r("new", 12)];
    const reports = [r("old", 1_000), r("new", 13)];
    expect(selectInboundReport(reports, previousReports[0]!, previousReports)?.id).toBe("new");
  });

  test("keeps the pinned report while it is still advancing", () => {
    const reports = [r("old", 1_010), r("new", 2_030)];
    expect(selectInboundReport(reports, { id: "old", framesReceived: 1_000 })?.id).toBe("old");
  });

  test("does not flap to a stalled sibling that happens to be behind", () => {
    const reports = [r("a", 500), r("b", 100)];
    expect(selectInboundReport(reports, { id: "a", framesReceived: 500 })?.id).toBe("a");
  });

  test("re-selects when the pinned report disappears", () => {
    expect(selectInboundReport([r("b", 7)], { id: "gone", framesReceived: 99 })?.id).toBe("b");
  });

  test("says nothing when there is nothing to judge", () => {
    expect(selectInboundReport([], { id: "a", framesReceived: 1 })).toBeNull();
  });
});
