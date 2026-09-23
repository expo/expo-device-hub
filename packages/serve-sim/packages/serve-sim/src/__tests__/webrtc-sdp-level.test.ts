import { describe, expect, it } from "bun:test";

import { H264_SEND_LEVEL_IDC, raiseH264OfferLevel } from "../client/webrtc-sdp-level";

/// The H.264 block Chrome offers, captured from a live session. Every payload is Level 3.1.
const CHROME_OFFER = [
  "v=0",
  "m=video 9 UDP/TLS/RTP/SAVPF 102 104 108 116 41 118",
  "a=rtpmap:102 H264/90000",
  "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
  "a=rtpmap:104 H264/90000",
  "a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f",
  "a=rtpmap:108 H264/90000",
  "a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  "a=rtpmap:116 H264/90000",
  "a=fmtp:116 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f",
  "a=rtpmap:41 H264/90000",
  "a=fmtp:41 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=f4001f",
  "a=rtpmap:118 H264/90000",
  "a=fmtp:118 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f",
].join("\r\n");

const levelsIn = (sdp: string): string[] => sdp.match(/profile-level-id=\w+/g) ?? [];
const withoutLevels = (sdp: string): string[] =>
  sdp.split("\r\n").filter((line) => !line.includes("profile-level-id="));

const raise = (value: string, level?: number) =>
  raiseH264OfferLevel(`a=fmtp:102 level-asymmetry-allowed=1;profile-level-id=${value}`, level)
    .replace("a=fmtp:102 level-asymmetry-allowed=1;profile-level-id=", "");

describe("raiseH264OfferLevel", () => {
  it("raises every H.264 payload in a real Chrome offer to Level 5.2", () => {
    expect(levelsIn(raiseH264OfferLevel(CHROME_OFFER))).toEqual([
      "profile-level-id=420034",
      "profile-level-id=420034",
      "profile-level-id=42e034",
      "profile-level-id=4d0034",
      "profile-level-id=f40034",
      "profile-level-id=640034",
    ]);
  });

  it("changes nothing else in the SDP", () => {
    const raised = raiseH264OfferLevel(CHROME_OFFER);
    expect(withoutLevels(raised)).toEqual(withoutLevels(CHROME_OFFER));
    expect(raised.split("\r\n")).toHaveLength(CHROME_OFFER.split("\r\n").length);
  });

  it("preserves profile_idc and profile_iop", () => {
    expect(raise("42e01f")).toBe("42e034");
    expect(raise("4d001f")).toBe("4d0034");
  });

  it("never lowers a level the peer already advertised higher", () => {
    expect(raise("640034")).toBe("640034");
    expect(raise("42e03c")).toBe("42e03c");
  });

  it("raises a level below the target but above 3.1", () => {
    expect(raise("42e02a")).toBe("42e034");
  });

  it("clears constraint_set3_flag when raising away from Level 1b", () => {
    // For Baseline, Main and Extended, level_idc 11 plus the flag means Level 1b.
    expect(raise("42100b")).toBe("420034");
    expect(raise("4d100b")).toBe("4d0034");
  });

  it("keeps constraint_set3_flag on High profiles, where it means Intra", () => {
    expect(raise("64100b")).toBe("641034");
  });

  it("keeps constraint flags when the source level is not 1b", () => {
    expect(raise("42101f")).toBe("421034");
  });

  it("leaves a malformed profile-level-id completely alone", () => {
    // Rewriting the first six digits of a longer run would corrupt it, and reading the
    // last two would report a level the peer never advertised.
    expect(raise("42e01fab")).toBe("42e01fab");
    expect(raise("42001f34")).toBe("42001f34");
    expect(raise("42e0")).toBe("42e0");
    expect(raise("zzzzzz")).toBe("zzzzzz");
  });

  /// Without asymmetry both directions share one level, so the answer would exceed what the
  /// browser's own offer allows. Only a payload that permits asymmetry can be raised.
  it("leaves a payload that does not allow level asymmetry at its own level", () => {
    const offer = [
      "a=fmtp:102 packetization-mode=1;profile-level-id=42e01f",
      "a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
      "a=fmtp:118 packetization-mode=1;profile-level-id=64001f;level-asymmetry-allowed=0",
    ].join("\r\n");
    expect(raiseH264OfferLevel(offer).split("\r\n")).toEqual([
      "a=fmtp:102 packetization-mode=1;profile-level-id=42e01f",
      "a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e034",
      "a=fmtp:118 packetization-mode=1;profile-level-id=64001f;level-asymmetry-allowed=0",
    ]);
  });

  it("ignores SDP with no H.264 fmtp lines", () => {
    const vp8 = "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000";
    expect(raiseH264OfferLevel(vp8)).toBe(vp8);
  });

  it("rejects an out-of-range target level instead of corrupting the SDP", () => {
    for (const bad of [0, -1, 0x100, 1.5, Number.NaN]) {
      expect(raiseH264OfferLevel(CHROME_OFFER, bad)).toBe(CHROME_OFFER);
    }
  });

  it("targets a level the Swift side reads back as 5.2", () => {
    expect(H264_SEND_LEVEL_IDC).toBe(0x34);
    expect(raise("42e01f")).toEndWith("34");
  });
});
