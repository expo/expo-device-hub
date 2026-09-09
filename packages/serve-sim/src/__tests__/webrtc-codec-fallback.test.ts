import { describe, expect, test } from "bun:test";
import {
  nextWebRtcFallbackCodec,
  webRtcFallbackDecision,
} from "../client/webrtc-codec-fallback";

describe("WebRTC codec fallback", () => {
  test("tries VP8 before VP9 when H264 produces no media", () => {
    expect(nextWebRtcFallbackCodec("h264", "h264")).toBe("vp8");
    expect(nextWebRtcFallbackCodec("h264", "vp8")).toBe("vp9");
    expect(nextWebRtcFallbackCodec("h264", "vp9")).toBe(null);
  });

  test("falls back from VP9 to mandatory VP8", () => {
    expect(nextWebRtcFallbackCodec("vp9", "vp9")).toBe("vp8");
    expect(nextWebRtcFallbackCodec("vp9", "vp8")).toBe(null);
  });

  test("switches the selected transport to HTTP after a permanent failure", () => {
    expect(webRtcFallbackDecision("h264", "h264", { kind: "permanent" })).toEqual({
      type: "switch-to-http",
    });
  });

  test("tries the next codec before switching the selected transport to HTTP", () => {
    expect(webRtcFallbackDecision("h264", "h264", { kind: "codec", codec: "h264" })).toEqual({
      type: "retry-codec",
      codec: "vp8",
    });
    expect(webRtcFallbackDecision("h264", "vp9", { kind: "codec", codec: "vp9" })).toEqual({
      type: "switch-to-http",
    });
  });

  test("ignores a stale codec failure from an earlier negotiation", () => {
    expect(webRtcFallbackDecision("h264", "vp8", { kind: "codec", codec: "h264" })).toBe(null);
  });
});
