import { describe, expect, test } from "bun:test";

import {
  describeStreamStats,
  readStreamStats,
  type StreamStatsSample,
} from "../client/utils/webrtc-stats";

/** RTCStatsReport is a Map with a typed forEach; a Map is a faithful stand-in. */
function report(entries: Record<string, unknown>[]): RTCStatsReport {
  return new Map(entries.map((entry) => [entry.id as string, entry])) as unknown as RTCStatsReport;
}

const INBOUND = {
  id: "in",
  type: "inbound-rtp",
  kind: "video",
  codecId: "c",
  framesDecoded: 100,
  framesDropped: 2,
  freezeCount: 1,
  totalFreezesDuration: 0.5,
  bytesReceived: 500_000,
  packetsReceived: 900,
  packetsLost: 100,
  framesPerSecond: 30,
  frameWidth: 1280,
  frameHeight: 720,
  jitter: 0.012,
  jitterBufferDelay: 4,
  jitterBufferEmittedCount: 100,
  totalInterFrameDelay: 3.3,
  totalSquaredInterFrameDelay: 0.111,
  totalDecodeTime: 0.4,
};

const CODEC = { id: "c", type: "codec", mimeType: "video/VP8" };

function sampleAt(atMs: number, overrides: Partial<StreamStatsSample> = {}): StreamStatsSample {
  return {
    atMs,
    framesDecoded: 0,
    framesDropped: 0,
    interFrameDelaySeconds: null,
    interFrameDelaySquaredSeconds: null,
    decodeSeconds: null,
    freezeCount: 0,
    freezeMs: 0,
    bytesReceived: 0,
    packetsReceived: 0,
    packetsLost: 0,
    jitterMs: null,
    jitterBufferSeconds: null,
    jitterBufferEmitted: null,
    reportedFps: null,
    width: null,
    height: null,
    codec: null,
    roundTripMs: null,
    path: "unknown",
    ...overrides,
  };
}

describe("readStreamStats", () => {
  test("converts libwebrtc seconds to milliseconds", () => {
    const sample = readStreamStats(report([CODEC, INBOUND]), 1_000);
    expect(sample.jitterMs).toBeCloseTo(12, 5);
    expect(sample.freezeMs).toBeCloseTo(500, 5);
    expect(sample.codec).toBe("video/VP8");
  });

  test("keeps the jitter buffer counters raw, since the windowed mean needs both samples", () => {
    const sample = readStreamStats(report([CODEC, INBOUND]), 1_000);
    expect(sample.jitterBufferSeconds).toBe(4);
    expect(sample.jitterBufferEmitted).toBe(100);
  });

  test("ignores audio", () => {
    const audio = { ...INBOUND, id: "a", kind: "audio", framesDecoded: 9_999 };
    expect(readStreamStats(report([audio]), 1_000).framesDecoded).toBe(0);
  });

  test("keeps the live video entry when a second one trails it in the report", () => {
    const stale = { ...INBOUND, id: "old", framesDecoded: 7, frameWidth: 320, frameHeight: 240 };
    const sample = readStreamStats(report([CODEC, INBOUND, stale]), 1_000);
    expect(sample.framesDecoded).toBe(100);
    expect(sample.width).toBe(1280);
  });

  test("reports absent packet loss as unknown rather than none", () => {
    const { packetsLost: _omitted, ...withoutLoss } = INBOUND;
    expect(readStreamStats(report([withoutLoss]), 1_000).packetsLost).toBeNull();
  });

  describe("candidate pair", () => {
    const relayPair = {
      id: "relay-pair",
      type: "candidate-pair",
      state: "succeeded",
      nominated: true,
      localCandidateId: "l-relay",
      remoteCandidateId: "r",
      currentRoundTripTime: 0.18,
    };
    const hostPair = {
      id: "host-pair",
      type: "candidate-pair",
      state: "succeeded",
      localCandidateId: "l-host",
      remoteCandidateId: "r",
      currentRoundTripTime: 0.005,
    };
    const candidates = [
      { id: "l-relay", type: "local-candidate", candidateType: "relay" },
      { id: "l-host", type: "local-candidate", candidateType: "host" },
      { id: "r", type: "remote-candidate", candidateType: "srflx" },
    ];

    test("follows the transport's selected pair over the nominated one", () => {
      // Points at the host pair while `relayPair` is the nominated one, so the two rules disagree
      // and the assertion can only pass if the transport wins.
      const transport = { id: "t", type: "transport", selectedCandidatePairId: "host-pair" };
      const sample = readStreamStats(
        report([INBOUND, transport, hostPair, relayPair, ...candidates]),
        1_000,
      );
      expect(sample.path).toBe("direct");
      expect(sample.roundTripMs).toBeCloseTo(5, 5);
    });

    test("prefers the nominated pair when no transport names one", () => {
      const sample = readStreamStats(report([INBOUND, hostPair, relayPair, ...candidates]), 1_000);
      expect(sample.path).toBe("relay");
      expect(sample.roundTripMs).toBeCloseTo(180, 5);
    });

    test("calls a host-to-srflx pair direct", () => {
      const sample = readStreamStats(report([INBOUND, hostPair, ...candidates]), 1_000);
      expect(sample.path).toBe("direct");
    });

    test("says unknown rather than guessing when a candidate type is missing", () => {
      const sample = readStreamStats(report([INBOUND, hostPair]), 1_000);
      expect(sample.path).toBe("unknown");
    });
  });

  test("falls back to the only codec when the entry carries no codecId", () => {
    const { codecId: _omitted, ...withoutCodecId } = INBOUND;
    expect(readStreamStats(report([CODEC, withoutCodecId]), 1_000).codec).toBe("video/VP8");
  });
});

describe("frame pacing and decode", () => {
  // Four frames 16ms apart: mean 16ms, no spread.
  test("reads near zero when every frame arrives on cadence", () => {
    const previous = sampleAt(1_000, {
      framesDecoded: 100, interFrameDelaySeconds: 0, interFrameDelaySquaredSeconds: 0,
    });
    const current = sampleAt(3_000, {
      framesDecoded: 104,
      interFrameDelaySeconds: 0.064,
      interFrameDelaySquaredSeconds: 4 * 0.016 * 0.016,
    });
    expect(describeStreamStats(previous, current).pacingDeviationMs).toBeCloseTo(0, 3);
    expect(describeStreamStats(previous, current).frameGapMs).toBeCloseTo(16, 3);
  });

  // Same four frames and the same mean, but delivered 2ms/30ms/2ms/30ms.
  test("separates a bursty stream from an even one at the same mean rate", () => {
    const previous = sampleAt(1_000, {
      framesDecoded: 100, interFrameDelaySeconds: 0, interFrameDelaySquaredSeconds: 0,
    });
    const current = sampleAt(3_000, {
      framesDecoded: 104,
      interFrameDelaySeconds: 0.064,
      interFrameDelaySquaredSeconds: 2 * 0.002 * 0.002 + 2 * 0.03 * 0.03,
    });
    expect(describeStreamStats(previous, current).pacingDeviationMs).toBeCloseTo(14, 0);
  });

  test("reports neither gap nor spread from a one-frame window, which has no spread by construction", () => {
    const previous = sampleAt(1_000, {
      framesDecoded: 100, interFrameDelaySeconds: 1, interFrameDelaySquaredSeconds: 0.02,
    });
    const current = sampleAt(3_000, {
      framesDecoded: 101, interFrameDelaySeconds: 1.4, interFrameDelaySquaredSeconds: 0.18,
    });
    const described = describeStreamStats(previous, current);
    expect(described.pacingDeviationMs).toBeNull();
    expect(described.frameGapMs).toBeNull();
  });

  test("reports nothing rather than a negative spread when the stream was replaced", () => {
    const previous = sampleAt(1_000, {
      framesDecoded: 100, interFrameDelaySeconds: 5, interFrameDelaySquaredSeconds: 0.4,
    });
    const current = sampleAt(3_000, {
      framesDecoded: 160, interFrameDelaySeconds: 1, interFrameDelaySquaredSeconds: 0.1,
    });
    expect(describeStreamStats(previous, current).pacingDeviationMs).toBeNull();
  });

  test("averages decode time over the frames of the window", () => {
    const previous = sampleAt(1_000, { framesDecoded: 100, decodeSeconds: 0.2 });
    const current = sampleAt(3_000, { framesDecoded: 160, decodeSeconds: 0.32 });
    expect(describeStreamStats(previous, current).decodeMsPerFrame).toBeCloseTo(2, 5);
  });
});

describe("describeStreamStats", () => {
  test("divides by the real window rather than assuming one second", () => {
    const previous = sampleAt(1_000, { framesDecoded: 100, bytesReceived: 100_000 });
    const current = sampleAt(3_000, { framesDecoded: 160, bytesReceived: 350_000 });
    const stats = describeStreamStats(previous, current);
    expect(stats.fps).toBeCloseTo(30, 5);
    expect(stats.kbps).toBeCloseTo(1_000, 5);
  });

  test("reports no rates from a single sample, rather than zero", () => {
    const stats = describeStreamStats(null, sampleAt(1_000, { framesDecoded: 100 }));
    expect(stats.fps).toBeNull();
    expect(stats.kbps).toBeNull();
    expect(stats.lossRatio).toBeNull();
    expect(stats.droppedInWindow).toBeNull();
    expect(stats.freezesInWindow).toBeNull();
    expect(stats.freezeMsInWindow).toBeNull();
    expect(stats.jitterBufferMs).toBeNull();
  });

  test("reports nothing for a window too short to divide by", () => {
    const stats = describeStreamStats(sampleAt(1_000), sampleAt(1_000));
    expect(stats.fps).toBeNull();
    expect(stats.droppedInWindow).toBeNull();
  });

  test("reports nothing when the clock steps backwards", () => {
    const stats = describeStreamStats(sampleAt(3_000), sampleAt(1_000));
    expect(stats.fps).toBeNull();
    expect(stats.droppedInWindow).toBeNull();
  });

  test("reports nothing when a counter resets, rather than a measured zero", () => {
    const previous = sampleAt(1_000, {
      framesDecoded: 100,
      bytesReceived: 100_000,
      framesDropped: 5,
      freezeCount: 2,
    });
    const current = sampleAt(3_000, {
      framesDecoded: 1,
      bytesReceived: 500,
      framesDropped: 0,
      freezeCount: 0,
    });
    const stats = describeStreamStats(previous, current);
    expect(stats.fps).toBeNull();
    expect(stats.kbps).toBeNull();
    expect(stats.droppedInWindow).toBeNull();
    expect(stats.freezesInWindow).toBeNull();
    expect(stats.freezeMsInWindow).toBeNull();
  });

  test("counts drops and freezes over the window", () => {
    const previous = sampleAt(1_000, { framesDropped: 5, freezeCount: 2, freezeMs: 4_000 });
    const current = sampleAt(3_000, { framesDropped: 9, freezeCount: 3, freezeMs: 5_500 });
    const stats = describeStreamStats(previous, current);
    expect(stats.droppedInWindow).toBe(4);
    expect(stats.freezesInWindow).toBe(1);
    expect(stats.freezeMsInWindow).toBe(1_500);
  });

  test("takes loss over the window, so it cannot exceed everything expected", () => {
    const previous = sampleAt(1_000, { packetsReceived: 1_000, packetsLost: 0 });
    const current = sampleAt(3_000, { packetsReceived: 1_180, packetsLost: 20 });
    expect(describeStreamStats(previous, current).lossRatio).toBeCloseTo(0.1, 5);
  });

  test("reports no loss ratio when the received count goes backwards", () => {
    const previous = sampleAt(1_000, { packetsReceived: 1_000, packetsLost: 0 });
    const current = sampleAt(3_000, { packetsReceived: 990, packetsLost: 30 });
    expect(describeStreamStats(previous, current).lossRatio).toBeNull();
  });

  test("reports no loss ratio while the receiver report is missing", () => {
    const previous = sampleAt(1_000, { packetsReceived: 1_000, packetsLost: null });
    const current = sampleAt(3_000, { packetsReceived: 1_200, packetsLost: null });
    expect(describeStreamStats(previous, current).lossRatio).toBeNull();
  });

  test("averages buffer delay over the frames emitted in the window", () => {
    // 0.4s of delay spread over 40 frames is 10ms a frame, regardless of the session mean.
    const previous = sampleAt(1_000, { jitterBufferSeconds: 4, jitterBufferEmitted: 100 });
    const current = sampleAt(3_000, { jitterBufferSeconds: 4.4, jitterBufferEmitted: 140 });
    expect(describeStreamStats(previous, current).jitterBufferMs).toBeCloseTo(10, 5);
  });

  test("reports no buffer delay when no frame was emitted in the window", () => {
    const previous = sampleAt(1_000, { jitterBufferSeconds: 4, jitterBufferEmitted: 100 });
    const current = sampleAt(3_000, { jitterBufferSeconds: 4, jitterBufferEmitted: 100 });
    expect(describeStreamStats(previous, current).jitterBufferMs).toBeNull();
  });
});
