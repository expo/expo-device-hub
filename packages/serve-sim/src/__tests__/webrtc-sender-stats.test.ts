import { describe, expect, test } from "bun:test";

import { simMiddleware } from "../middleware";
import { readSenderStats, senderSessionForViewer } from "../webrtc-sender-stats";

/** One session as the addon encodes it: seconds, bits per second, keys omitted when unknown. */
const SESSION = {
  sessionId: "00000000-0000-4000-8000-000000000000",
  codec: "H264",
  connected: true,
  qualityLimitationReason: "cpu",
  qualityLimitationDurations: { none: 12.5, cpu: 3, bandwidth: 0, other: 0 },
  framesEncoded: 600,
  framesSent: 598,
  framesPerSecond: 29.5,
  targetBitrate: 4_000_000,
  totalEncodeTime: 6,
  frameWidth: 1170,
  frameHeight: 2532,
  packetsSent: 5_000,
  packetsLost: 50,
  roundTripTime: 0.021,
  localCandidateType: "host",
  remoteCandidateType: "srflx",
};

describe("readSenderStats", () => {
  test("converts seconds to milliseconds and bits to kbps", () => {
    const [session] = readSenderStats({ sessions: [SESSION] }).sessions;

    expect(session?.roundTripMs).toBeCloseTo(21, 5);
    expect(session?.totalEncodeMs).toBeCloseTo(6_000, 5);
    expect(session?.targetKbps).toBeCloseTo(4_000, 5);
    expect(session?.qualityLimitationMs.cpu).toBeCloseTo(3_000, 5);
  });

  test("keeps the limitation reason, the field a receiving browser cannot see", () => {
    const [session] = readSenderStats({ sessions: [SESSION] }).sessions;

    expect(session?.qualityLimitationReason).toBe("cpu");
  });

  test("spreads the encode cost over the frames it covers", () => {
    const [session] = readSenderStats({ sessions: [SESSION] }).sessions;

    expect(session?.encodeMsPerFrame).toBeCloseTo(10, 5);
  });

  test("reports no per-frame encode cost before the first frame, rather than dividing by zero", () => {
    const [session] = readSenderStats({
      sessions: [{ ...SESSION, framesEncoded: 0, totalEncodeTime: 0 }],
    }).sessions;

    expect(session?.encodeMsPerFrame).toBeNull();
  });

  test("names a TURN-relayed path, which is the expensive one", () => {
    const [session] = readSenderStats({
      sessions: [{ ...SESSION, localCandidateType: "relay" }],
    }).sessions;

    expect(session?.path).toBe("relay");
  });

  test("calls a host-to-srflx pair direct", () => {
    const [session] = readSenderStats({ sessions: [SESSION] }).sessions;

    expect(session?.path).toBe("direct");
  });

  test("says unknown rather than guessing when a candidate type is missing", () => {
    const [session] = readSenderStats({
      sessions: [{ ...SESSION, remoteCandidateType: undefined }],
    }).sessions;

    expect(session?.path).toBe("unknown");
  });

  test("measures loss against the packets actually sent", () => {
    const [session] = readSenderStats({ sessions: [SESSION] }).sessions;

    expect(session?.lossRatio).toBeCloseTo(0.01, 5);
  });

  test("reports no loss ratio before any packet is sent", () => {
    const [session] = readSenderStats({
      sessions: [{ ...SESSION, packetsSent: 0, packetsLost: 0 }],
    }).sessions;

    expect(session?.lossRatio).toBeNull();
  });

  test("survives a session the publisher barely knows anything about", () => {
    const [session] = readSenderStats({
      sessions: [{ sessionId: "s", codec: "VP8", connected: false }],
    }).sessions;

    expect(session?.framesEncoded).toBe(0);
    expect(session?.reportedFps).toBeNull();
    expect(session?.targetKbps).toBeNull();
    expect(session?.roundTripMs).toBeNull();
    expect(session?.qualityLimitationReason).toBeNull();
    expect(session?.qualityLimitationMs).toEqual({});
    expect(session?.path).toBe("unknown");
  });

  test("returns no sessions when nothing is streaming", () => {
    expect(readSenderStats({ sessions: [] }).sessions).toEqual([]);
  });

  test("returns no sessions for a payload that is not a report", () => {
    expect(readSenderStats(null).sessions).toEqual([]);
    expect(readSenderStats({ sessions: "nope" }).sessions).toEqual([]);
    expect(readSenderStats({ sessions: [42, null] }).sessions).toEqual([]);
  });
});

describe("GET /webrtc/stats", () => {
  // The browser panel fetches this, and on an embedded mount that is cross-origin, so it needs the
  // same preflight the offer route gets.
  test("answers the CORS preflight the way the offer route does", async () => {
    const middleware = simMiddleware({ basePath: "/.sim", proxyHelpers: true });
    const response = await middleware(new Request(
      "http://localhost/.sim/helper/00000000-0000-4000-8000-000000000000/webrtc/stats",
      { method: "OPTIONS" },
    ));

    expect(response?.status).toBe(204);
    expect(response?.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("answers the same preflight when the panel scopes the request to one session", async () => {
    const middleware = simMiddleware({ basePath: "/.sim", proxyHelpers: true });
    const response = await middleware(new Request(
      "http://localhost/.sim/helper/00000000-0000-4000-8000-000000000000/webrtc/stats?sessionId=07a5f32b-273e-4a30-8f62-8e741a815af1",
      { method: "OPTIONS" },
    ));

    expect(response?.status).toBe(204);
  });
});

describe("capture counts", () => {
  test("keeps the screen and idle split, which distinguishes a static screen from a stall", () => {
    const stats = readSenderStats({ sessions: [], capture: { screenFrames: 900, idleFrames: 40 } });

    expect(stats.capture).toEqual({
      screenFrames: 900,
      idleFrames: 40,
      offeredFrames: null,
      forwardedFrames: null,
      pumpRestarts: null,
    });
  });

  test("reports null rather than zeros when the counts are absent", () => {
    expect(readSenderStats({ sessions: [] }).capture).toBeNull();
  });

  test("rejects non-numeric counts instead of coercing them", () => {
    expect(readSenderStats({ sessions: [], capture: { screenFrames: "900", idleFrames: 40 } }).capture)
      .toBeNull();
  });
});

describe("frame flow counts", () => {
  test("keeps capture deliveries and paced submissions as distinct stages", () => {
    const stats = readSenderStats({
      sessions: [],
      capture: { screenFrames: 900, idleFrames: 40, offeredFrames: 880, forwardedFrames: 300 },
    });

    expect(stats.capture?.offeredFrames).toBe(880);
    expect(stats.capture?.forwardedFrames).toBe(300);
  });
});

describe("source frame stats", () => {
  test("keeps libwebrtc's own source counts, the link between forwarded and encoded", () => {
    const [session] = readSenderStats({
      sessions: [{ sessionId: "s", sourceFrames: 3200, sourceFramesPerSecond: 54, sourceFramesDropped: 40 }],
    }).sessions;

    expect(session!.sourceFrames).toBe(3200);
    expect(session!.sourceFps).toBe(54);
    expect(session!.sourceFramesDropped).toBe(40);
  });

  test("reports null when libwebrtc omits them, rather than zero", () => {
    const [session] = readSenderStats({ sessions: [{ sessionId: "s" }] }).sessions;

    expect(session!.sourceFrames).toBeNull();
    expect(session!.sourceFramesDropped).toBeNull();
  });
});

describe("senderSessionForViewer", () => {
  test("picks this viewer's session rather than the first connected one", () => {
    const theirs = { ...SESSION, sessionId: "11111111-1111-4111-8111-111111111111", codec: "VP8" };
    const ours = { ...SESSION, sessionId: "22222222-2222-4222-8222-222222222222", codec: "H264" };
    const sessions = readSenderStats({ sessions: [theirs, ours] }).sessions;

    expect(senderSessionForViewer(sessions, ours.sessionId)?.codec).toBe("H264");
    expect(senderSessionForViewer(sessions, "33333333-3333-4333-8333-333333333333")).toBeNull();
  });
});
