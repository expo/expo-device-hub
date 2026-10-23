import { describe, expect, test } from "bun:test";
import {
  parseIceUrlList,
  redactedStreamSettings,
  viewerTransportsFor,
  webSocketVideoAllowed,
} from "../src/stream-settings.ts";

describe("stream settings", () => {
  test("parses comma-separated STUN and TURN URLs", () => {
    expect(parseIceUrlList("stun:one.example:3478, stuns:two.example:5349", "stun")).toEqual([
      "stun:one.example:3478",
      "stuns:two.example:5349",
    ]);
    expect(parseIceUrlList("turn:turn.example:3478?transport=udp", "turn")).toEqual([
      "turn:turn.example:3478?transport=udp",
    ]);
  });

  test("rejects ICE URLs with the wrong scheme", () => {
    expect(() => parseIceUrlList("https://example.test", "stun")).toThrow(
      "Expected one or more comma-separated STUN URLs",
    );
    expect(() => parseIceUrlList("stun:stun.example:3478", "turn")).toThrow(
      "Expected one or more comma-separated TURN URLs",
    );
  });

  test("redacts TURN credentials in stream-health output", () => {
    expect(
      redactedStreamSettings({
        transport: "webrtc",
        codec: "h264",
        iceTransportPolicy: "all",
        iceServers: [
          {
            urls: ["turn:turn.example:3478"],
            username: "user",
            credential: "secret",
          },
        ],
      }),
    ).toEqual({
      transport: "webrtc",
      codec: "h264",
      iceTransportPolicy: "all",
      iceServers: [
        {
          urls: ["turn:turn.example:3478"],
          username: "user",
          credential: "redacted",
        },
      ],
    });
  });

  test("builds viewer-local transport catalogs from the active codec", () => {
    expect(viewerTransportsFor({ transport: "websocket" }, "h264")).toEqual({
      default: "websocket",
      available: ["websocket", "webrtc"],
      webrtc: {
        transport: "webrtc",
        codec: "h264",
        iceTransportPolicy: "all",
        iceServers: [
          { urls: ["stun:stun.l.google.com:19302"] },
          { urls: ["stun:stun1.l.google.com:19302"] },
        ],
      },
    });

    const configured = {
      transport: "webrtc" as const,
      codec: "h264" as const,
      iceServers: [
        {
          urls: ["turn:turn.example:3478"],
          username: "user",
          credential: "secret",
        },
      ],
      iceTransportPolicy: "relay" as const,
    };
    // WebRTC is the only video transport then, as with serve-sim's `--transport webrtc`.
    expect(viewerTransportsFor(configured, "h264")).toEqual({
      default: "webrtc",
      available: ["webrtc"],
      webrtc: configured,
    });
    expect(viewerTransportsFor(configured, "av1")).toEqual({
      default: "websocket",
      available: ["websocket"],
      webrtc: null,
    });
  });
});

describe("webSocketVideoAllowed", () => {
  test("refuses WebSocket video only when WebRTC is configured and possible", () => {
    const webrtc = {
      transport: "webrtc" as const,
      codec: "h264" as const,
      iceServers: [],
      iceTransportPolicy: "all" as const,
    };
    expect(webSocketVideoAllowed({ transport: "websocket" }, "h264")).toBe(true);
    expect(webSocketVideoAllowed(webrtc, "h264")).toBe(false);
    // Without H.264 there is no WebRTC, so the WebSocket keeps the video.
    expect(webSocketVideoAllowed(webrtc, "av1")).toBe(true);
  });
});
