import { describe, expect, test } from "bun:test";

import type { WebRtcPublisherSessionStats } from "../src/webrtc-publisher.ts";
import {
  handleWebRtcStatsRequest,
  WebRtcStatsCollector,
  type WebRtcStatsReport,
} from "../src/webrtc-stats.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000000";

const publisherSession: WebRtcPublisherSessionStats = {
  sessionId: SESSION_ID,
  state: "connected",
  iceState: "completed",
  connected: true,
  submittedFrames: 1_190,
  publisherDroppedFrames: 10,
  payloadBytesSubmitted: 5_750_000,
  path: "relay",
  localCandidateType: "host",
  remoteCandidateType: "relay",
  localCandidateTransport: "udp",
  remoteCandidateTransport: "udp",
};

describe("serve-emu WebRTC stats report", () => {
  test("owns capture accounting and viewer-scoped report assembly", () => {
    const collector = new WebRtcStatsCollector(() => 42);
    collector.recordDelivery(undefined);
    collector.recordDelivery({ accepted: false, awaitingKeyFrame: false });
    collector.recordDelivery({ accepted: true, awaitingKeyFrame: false });
    collector.recordDelivery({ accepted: false, awaitingKeyFrame: true });
    const publisher = {
      statsForSession: (sessionId: string) =>
        sessionId === SESSION_ID ? publisherSession : null,
    };
    const source = {
      streamMode: "grpc-screenshot" as const,
      codec: "h264",
      width: 1080,
      height: 2400,
      frames: 1_200,
      fps: 29,
      configuredFps: 60,
      configuredBitrateBps: 8_000_000,
      frameStats: {
        windowFrames: 240,
        intervalMs: { p50: 16.7, p95: 20.1, max: 30 },
        avgKeyFrameBytes: 90_000,
        avgDeltaFrameBytes: 12_000,
        keyFramesInWindow: 4,
      },
    };

    expect(collector.report(source, publisher, SESSION_ID)).toEqual({
      sampledAt: 42,
      source,
      sessions: [publisherSession],
      capture: { offeredFrames: 2, forwardedFrames: 1, grpc: null },
    });
    expect(
      collector.report(
        source,
        publisher,
        "11111111-1111-4111-8111-111111111111",
      ),
    ).toBeNull();
  });
});

describe("GET /webrtc/stats", () => {
  const report = new WebRtcStatsCollector(() => 42).report(
    {
      streamMode: "scrcpy",
      codec: "h264",
      width: 1080,
      height: 2400,
      frames: 1_200,
      fps: 29,
      configuredFps: 60,
      configuredBitrateBps: 8_000_000,
      frameStats: null,
    },
    { statsForSession: () => publisherSession },
    SESSION_ID,
    null,
  )!;

  function request(
    path = `/webrtc/stats?sessionId=${SESSION_ID}`,
    init?: RequestInit,
    readStats: (
      sessionId: string,
      device: string | null,
    ) => WebRtcStatsReport | null = () => report,
  ) {
    return handleWebRtcStatsRequest(
      new Request(`http://localhost${path}`, init),
      {},
      readStats,
    );
  }

  test("returns a no-store report scoped to the requested viewer", async () => {
    let requestedSessionId: string | undefined;
    let requestedDevice: string | null | undefined;
    const response = request(
      `/webrtc/stats?sessionId=${SESSION_ID}&device=emulator-5554`,
      undefined,
      (sessionId, device) => {
        requestedSessionId = sessionId;
        requestedDevice = device;
        return report;
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(requestedSessionId).toBe(SESSION_ID);
    expect(requestedDevice).toBe("emulator-5554");
    expect(await response.json()).toEqual(report);
  });

  test("requires viewer scoping and reports an unknown viewer as unavailable", async () => {
    let requestedSessionId: string | undefined = "unset";
    const missing = request("/webrtc/stats", undefined, (sessionId) => {
      requestedSessionId = sessionId;
      return report;
    });
    const unknown = request(undefined, undefined, () => null);

    expect(requestedSessionId).toBe("unset");
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      ok: false,
      error: "missing_session_id",
      message: "WebRTC session ID is required",
    });
    expect(unknown.status).toBe(503);
    expect(await unknown.json()).toEqual({
      ok: false,
      error: "webrtc_stats_unavailable",
    });
  });

  test("validates the session, device, and method before reading live state", async () => {
    let reads = 0;
    const readStats = () => {
      reads++;
      return report;
    };
    const invalid = request("/webrtc/stats?sessionId=invalid", undefined, readStats);
    const duplicate = request(
      `/webrtc/stats?sessionId=${SESSION_ID}&device=one&device=two`,
      undefined,
      readStats,
    );
    const oversized = request(
      `/webrtc/stats?sessionId=${SESSION_ID}&device=${"x".repeat(257)}`,
      undefined,
      readStats,
    );
    const unsupported = request("/webrtc/stats", { method: "POST" }, readStats);

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      ok: false,
      error: "invalid_session_id",
      message: "Invalid WebRTC session ID",
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({
      ok: false,
      error: "invalid_device",
    });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({
      ok: false,
      error: "invalid_device",
    });
    expect(unsupported.status).toBe(405);
    expect(await unsupported.json()).toEqual({
      ok: false,
      error: "method_not_allowed",
    });
    expect(reads).toBe(0);
  });

  test("answers CORS preflight without reading live state", () => {
    let reads = 0;
    const response = request(
      "/webrtc/stats",
      { method: "OPTIONS", headers: { Origin: "http://127.0.0.1:3400" } },
      () => {
        reads++;
        return report;
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:3400",
    );
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(reads).toBe(0);
  });

  test("rejects forbidden origins and keeps internal failures private", async () => {
    const forbidden = handleWebRtcStatsRequest(
      new Request("http://localhost/webrtc/stats", {
        headers: { Origin: "https://evil.example" },
      }),
      {},
      () => report,
    );
    const errors: unknown[] = [];
    const failed = handleWebRtcStatsRequest(
      new Request(`http://localhost/webrtc/stats?sessionId=${SESSION_ID}`),
      {},
      () => {
        throw new Error("secret host path /Users/example");
      },
      (error) => errors.push(error),
    );

    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      ok: false,
      error: "forbidden_origin",
    });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      ok: false,
      error: "webrtc_stats_unavailable",
    });
    expect(errors).toHaveLength(1);
  });
});
