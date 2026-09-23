import { describe, expect, test } from "bun:test";
import { webRtcFailureDisposition } from "../client/webrtc-failure-policy";

describe("WebRTC failure policy", () => {
  test("uses codec fallback only when a connected peer cannot decode its first frame", () => {
    expect(webRtcFailureDisposition("first-frame-timeout", "connected")).toBe("codec");
  });

  test("keeps waiting when media is arriving but has not rendered yet", () => {
    // A large first keyframe can arrive inside the connection and still paint after the
    // deadline; downgrading the codec there throws away a working stream.
    expect(webRtcFailureDisposition("first-frame-timeout", "connected", { mediaArriving: true }))
      .toBe("wait");
  });

  test("still blames the codec when nothing at all is arriving", () => {
    expect(webRtcFailureDisposition("first-frame-timeout", "connected", { mediaArriving: false }))
      .toBe("codec");
  });

  test("retries transport when the peer never connected", () => {
    expect(webRtcFailureDisposition("first-frame-timeout", "connecting")).toBe("transport");
  });

  test("does not reinterpret signaling or established connection failures as codec failures", () => {
    expect(webRtcFailureDisposition("signaling-failed", "new")).toBe("transport");
    expect(webRtcFailureDisposition("connection-failed", "failed")).toBe("transport");
  });
});
