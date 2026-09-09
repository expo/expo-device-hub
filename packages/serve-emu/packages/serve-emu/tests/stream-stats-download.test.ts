import { describe, expect, test } from "bun:test";
import {
  createBrowserStreamStatsDownloadAdapter,
  downloadStreamStats,
  sanitizeStreamStatsValue,
  type StreamStatsDownloadFile,
} from "../src/ui/lib/stream-stats-download.ts";

const NOW = Date.parse("2026-09-02T12:34:56.789Z");
const SESSION_ID = "00000000-0000-4000-8000-000000000000";

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

const viewerState = {
  status: "streaming",
  generation: 7,
  lastRenderedAt: NOW - 10,
  fps: 59.5,
  deviceSize: { width: 1080, height: 1920 },
  stats: {
    fps: 59,
    decodeQueue: 2,
    transitMs: 4.2,
    e2eMs: 12.8,
    codec: "avc1.640028",
    rendered: true,
    ignored: "not exported",
  },
  ignored: "not exported",
};

describe("stream statistics download", () => {
  test("downloads bounded WebSocket viewer and health snapshots", async () => {
    const requests: Array<{ path: string; init: RequestInit | undefined }> = [];
    const downloads: StreamStatsDownloadFile[] = [];

    const result = await downloadStreamStats(
      {
        transport: "websocket",
        viewerState,
        webRtcSessionId: SESSION_ID,
      },
      {
        clock: { now: () => NOW },
        fetch: async (input, init) => {
          requests.push({ path: String(input), init });
          return jsonResponse({
            ok: true,
            serial: "emulator-5554",
            frames: 42,
          });
        },
        download: (file) => {
          downloads.push(file);
        },
      },
    );

    expect(requests.map(({ path }) => path)).toEqual(["/health"]);
    expect(requests[0]?.init).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(result.filename).toBe(
      "serve-emu-emulator-5554-websocket-2026-09-02T12-34-56-789Z.json",
    );
    expect(result.blob.type).toStartWith("application/json");
    expect(result.document).toEqual({
      schemaVersion: 1,
      sampledAt: "2026-09-02T12:34:56.789Z",
      viewer: {
        transport: "websocket",
        status: "streaming",
        generation: 7,
        lastRenderedAt: NOW - 10,
        fps: 59.5,
        deviceSize: { width: 1080, height: 1920 },
        stats: {
          fps: 59,
          decodeQueue: 2,
          transitMs: 4.2,
          e2eMs: 12.8,
          codec: "avc1.640028",
          rendered: true,
        },
      },
      server: {
        health: { ok: true, serial: "emulator-5554", frames: 42 },
        webrtc: null,
      },
      errors: [],
    });
    expect(downloads).toEqual([
      { filename: result.filename, blob: result.blob },
    ]);
    expect(JSON.parse(await result.blob.text())).toEqual(result.document);
  });

  test("requests only the current WebRTC session and recursively redacts secrets", async () => {
    const requests: string[] = [];
    const result = await downloadStreamStats(
      {
        transport: "webrtc",
        viewerState,
        webRtcSessionId: SESSION_ID,
      },
      {
        clock: { now: () => NOW },
        fetch: async (input) => {
          const path = String(input);
          requests.push(path);
          if (path === "/health") {
            return jsonResponse({
              serial: "Pixel 8/API 35",
              authToken: "health-secret",
              authHeader: "opaque-auth-secret",
              callback: "https://example.test/callback?access_token=url-secret",
              error: "request failed with Authorization Bearer embedded-secret",
              nested: { cookie: "session=health-secret" },
            });
          }
          return jsonResponse({
            sessions: [
              {
                sessionId: SESSION_ID,
                localCandidateType: "host",
                localCandidateAddress: "192.0.2.10",
                remoteCandidateTransport: "udp",
                sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96",
              },
            ],
            iceServers: [
              {
                urls: ["turn:relay.example.test"],
                username: "relay-user",
                credential: "relay-password",
              },
            ],
            note: "Authorization: Bearer viewer-secret",
          });
        },
        download: () => {},
      },
    );

    expect(requests.sort()).toEqual([
      "/health",
      `/webrtc/stats?sessionId=${SESSION_ID}`,
    ]);
    const serialized = await result.blob.text();
    for (const secret of [
      "health-secret",
      "opaque-auth-secret",
      "url-secret",
      "embedded-secret",
      "session=health-secret",
      "192.0.2.10",
      "relay.example.test",
      "relay-user",
      "relay-password",
      "viewer-secret",
      "m=video",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(result.document.server.health).toEqual({
      serial: "Pixel 8/API 35",
      authToken: "[redacted]",
      authHeader: "[redacted]",
      callback: "[redacted]",
      error: "[redacted]",
      nested: { cookie: "[redacted]" },
    });
    expect(result.document.server.webrtc).toMatchObject({
      sessions: [
        {
          sessionId: SESSION_ID,
          localCandidateType: "host",
          localCandidateAddress: "[redacted]",
          remoteCandidateTransport: "udp",
          sdp: "[redacted]",
        },
      ],
      iceServers: [
        {
          urls: "[redacted]",
          username: "[redacted]",
          credential: "[redacted]",
        },
      ],
      note: "[redacted]",
    });
    expect(result.filename).toBe(
      "serve-emu-Pixel-8-API-35-webrtc-2026-09-02T12-34-56-789Z.json",
    );
  });

  test("downloads partial data with safe errors when requests fail", async () => {
    let downloadCount = 0;
    const result = await downloadStreamStats(
      {
        transport: "webrtc",
        viewerState: {
          ...viewerState,
          fps: Number.POSITIVE_INFINITY,
          deviceSize: { width: 100_000, height: 1920 },
        },
        webRtcSessionId: SESSION_ID,
      },
      {
        clock: { now: () => NOW },
        fetch: async (input) => {
          if (String(input) === "/health") {
            throw new Error("Bearer should-never-be-exported");
          }
          return new Response("credential=also-secret", { status: 503 });
        },
        download: () => {
          downloadCount += 1;
        },
      },
    );

    expect(downloadCount).toBe(1);
    expect(result.document.viewer.fps).toBeNull();
    expect(result.document.viewer.deviceSize).toBeNull();
    expect(result.document.server).toEqual({ health: null, webrtc: null });
    expect(result.document.errors).toEqual([
      { source: "health", message: "health request failed" },
      { source: "webrtc", message: "webrtc request failed with HTTP 503" },
    ]);
    const serialized = await result.blob.text();
    expect(serialized).not.toContain("should-never-be-exported");
    expect(serialized).not.toContain("also-secret");
  });

  test("preserves structured health diagnostics returned with HTTP 503", async () => {
    const result = await downloadStreamStats(
      {
        transport: "websocket",
        viewerState,
        webRtcSessionId: null,
      },
      {
        clock: { now: () => NOW },
        fetch: async () =>
          jsonResponse(
            {
              ok: false,
              status: "error",
              serial: "emulator-5554",
              lastError: "video stream ended",
            },
            503,
          ),
        download: () => {},
      },
    );

    expect(result.document.server.health).toEqual({
      ok: false,
      status: "error",
      serial: "emulator-5554",
      lastError: "video stream ended",
    });
    expect(result.document.errors).toEqual([
      { source: "health", message: "health request failed with HTTP 503" },
    ]);
    expect(result.filename).toStartWith("serve-emu-emulator-5554-websocket-");
  });

  test("times out a hung sample and still downloads a partial document", async () => {
    let downloads = 0;
    const result = await downloadStreamStats(
      {
        transport: "websocket",
        viewerState,
        webRtcSessionId: null,
      },
      {
        clock: { now: () => NOW },
        requestTimeoutMs: 1,
        fetch: async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
        download: () => {
          downloads++;
        },
      },
    );

    expect(downloads).toBe(1);
    expect(result.document.server.health).toBeNull();
    expect(result.document.errors).toEqual([
      { source: "health", message: "health request timed out" },
    ]);
  });

  test("rejects oversized server JSON before parsing", async () => {
    const result = await downloadStreamStats(
      {
        transport: "websocket",
        viewerState,
        webRtcSessionId: null,
      },
      {
        clock: { now: () => NOW },
        fetch: async () =>
          new Response("{}", {
            headers: { "Content-Length": String(3 * 1024 * 1024) },
          }),
        download: () => {},
      },
    );

    expect(result.document.server.health).toBeNull();
    expect(result.document.errors).toEqual([
      { source: "health", message: "health response was too large" },
    ]);
  });

  test("still downloads when a WebRTC session ID is absent", async () => {
    const requests: string[] = [];
    const result = await downloadStreamStats(
      {
        transport: "webrtc",
        viewerState,
        webRtcSessionId: null,
      },
      {
        clock: { now: () => NOW },
        fetch: async (input) => {
          requests.push(String(input));
          return jsonResponse({ serial: "emulator-5554" });
        },
        download: () => {},
      },
    );

    expect(requests).toEqual(["/health"]);
    expect(result.document.server.webrtc).toBeNull();
    expect(result.document.errors).toEqual([
      { source: "webrtc", message: "WebRTC session ID is unavailable" },
    ]);
  });

  test("sanitizer handles candidate values, cycles, and source immutability", () => {
    const source: Record<string, unknown> = {
      safe: "direct",
      remoteCandidateType: "relay",
      candidate: "candidate:1 1 UDP 1 203.0.113.5 5000 typ host",
      password: "not-for-export",
    };
    source.self = source;

    expect(sanitizeStreamStatsValue(source)).toEqual({
      safe: "direct",
      remoteCandidateType: "relay",
      candidate: "[redacted]",
      password: "[redacted]",
      self: "[truncated]",
    });
    expect(source.password).toBe("not-for-export");
  });

  test("browser adapter clicks an anchor and always revokes its object URL", async () => {
    const events: string[] = [];
    const anchor = {
      href: "",
      download: "",
      hidden: false,
      click: () => events.push("click"),
      remove: () => events.push("remove"),
    };
    const adapter = createBrowserStreamStatsDownloadAdapter({
      createObjectUrl: (blob) => {
        events.push(`create:${blob.type}`);
        return "blob:stats";
      },
      revokeObjectUrl: (url) => events.push(`revoke:${url}`),
      createAnchor: () => anchor,
      appendAnchor: () => events.push("append"),
    });

    await adapter({
      filename: "stats.json",
      blob: new Blob(["{}"], { type: "application/json" }),
    });

    expect(anchor).toMatchObject({
      href: "blob:stats",
      download: "stats.json",
      hidden: true,
    });
    expect(events).toEqual([
      `create:${new Blob([], { type: "application/json" }).type}`,
      "append",
      "click",
      "remove",
      "revoke:blob:stats",
    ]);

    const cleanupEvents: string[] = [];
    const failingAdapter = createBrowserStreamStatsDownloadAdapter({
      createObjectUrl: () => "blob:failing-stats",
      revokeObjectUrl: (url) => cleanupEvents.push(`revoke:${url}`),
      createAnchor: () => ({
        href: "",
        download: "",
        hidden: false,
        click: () => {},
        remove: () => {
          cleanupEvents.push("remove");
          throw new Error("remove failed");
        },
      }),
      appendAnchor: () => {},
    });
    expect(() =>
      failingAdapter({
        filename: "stats.json",
        blob: new Blob(["{}"], { type: "application/json" }),
      })
    ).toThrow("remove failed");
    expect(cleanupEvents).toEqual(["remove", "revoke:blob:failing-stats"]);
  });
});
