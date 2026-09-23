import { describe, expect, test } from "bun:test";
import {
  WebRtcSignalingError,
  parseWebRtcCloseRequest,
  parseWebRtcOffer,
  parseWebRtcStatsSessionId,
} from "../webrtc-signaling";

const sessionId = "07a5f32b-273e-4a30-8f62-8e741a815af1";

describe("WebRTC signaling validation", () => {
  test("accepts a bounded offer with ICE credentials", () => {
    expect(parseWebRtcOffer({
      type: "offer",
      sdp: "v=0\r\n",
      sessionId,
      codec: "vp8",
      iceServers: [{
        urls: ["turns:turn.example.test:5349"],
        username: "user",
        credential: "secret",
      }],
    })).toEqual({
      type: "offer",
      sdp: "v=0\r\n",
      sessionId,
      codec: "vp8",
      iceServers: [{
        urls: ["turns:turn.example.test:5349"],
        username: "user",
        credential: "secret",
      }],
    });
  });

  test("rejects malformed session IDs, codecs, and ICE URLs", () => {
    for (const offer of [
      { type: "offer", sdp: "v=0", sessionId: "not-a-uuid" },
      { type: "offer", sdp: "v=0", sessionId, codec: "av1" },
      { type: "offer", sdp: "v=0", sessionId, iceServers: [{ urls: ["https://example.test"] }] },
    ]) {
      expect(() => parseWebRtcOffer(offer)).toThrow(WebRtcSignalingError);
    }
  });

  test("validates close requests independently from offers", () => {
    expect(parseWebRtcCloseRequest({ sessionId })).toEqual({ sessionId });
    expect(() => parseWebRtcCloseRequest({ sessionId: "" })).toThrow(WebRtcSignalingError);
  });

  test("treats a missing stats session id as every session", () => {
    expect(parseWebRtcStatsSessionId(null)).toBeUndefined();
    expect(parseWebRtcStatsSessionId("")).toBeUndefined();
    expect(parseWebRtcStatsSessionId(sessionId)).toBe(sessionId);
    expect(() => parseWebRtcStatsSessionId("not-a-uuid")).toThrow(WebRtcSignalingError);
  });
});
