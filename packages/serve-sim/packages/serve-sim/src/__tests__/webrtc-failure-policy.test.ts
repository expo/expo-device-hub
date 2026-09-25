import { describe, expect, test } from "bun:test";
import {
  offerFailureIsTransient,
  playbackStallAction,
  STALL_RECONNECT_TTL_MS,
  webRtcFailureDisposition,
} from "../client/webrtc-failure-policy";

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

describe("playback stall, after the stream has already painted", () => {
  test("blames the codec when media still arrives but nothing paints", () => {
    expect(webRtcFailureDisposition("playback-stall", "connected", { mediaArriving: true }))
      .toBe("codec");
  });

  test("blames the transport when media stopped arriving too", () => {
    expect(webRtcFailureDisposition("playback-stall", "connected", { mediaArriving: false }))
      .toBe("transport");
  });

  test("never waits, because a decoder that already choked will not recover on its own", () => {
    for (const arriving of [true, false]) {
      expect(webRtcFailureDisposition("playback-stall", "connected", { mediaArriving: arriving }))
        .not.toBe("wait");
    }
  });

  test("is the opposite of a first-frame timeout for the same inputs", () => {
    const progress = { mediaArriving: true };
    expect(webRtcFailureDisposition("first-frame-timeout", "connected", progress)).toBe("wait");
    expect(webRtcFailureDisposition("playback-stall", "connected", progress)).toBe("codec");
  });

  test("defers to the transport whenever the connection is not up", () => {
    for (const state of ["connecting", "disconnected", "failed", "closed", "new"] as const) {
      expect(webRtcFailureDisposition("playback-stall", state, { mediaArriving: true }))
        .toBe("transport");
    }
  });
});

describe("who to blame when nothing arrives before the first frame", () => {
  const timeout = (senderEncoding: boolean | null | undefined) =>
    webRtcFailureDisposition("first-frame-timeout", "connected", {
      mediaArriving: false,
      senderEncoding,
    });

  test("blames the transport when the sender is encoding and we receive nothing", () => {
    expect(timeout(true)).toBe("transport");
  });

  test("blames the codec when the sender encoded nothing at all", () => {
    expect(timeout(false)).toBe("codec");
  });

  test("blames the codec when the sender could not be asked", () => {
    expect(timeout(null)).toBe("codec");
    expect(timeout(undefined)).toBe("codec");
  });

  test("arriving media still outranks the sender's opinion", () => {
    expect(webRtcFailureDisposition("first-frame-timeout", "connected", {
      mediaArriving: true,
      senderEncoding: false,
    })).toBe("wait");
  });

  test("a connection that is not up is the transport's problem regardless", () => {
    expect(webRtcFailureDisposition("first-frame-timeout", "failed", {
      mediaArriving: false,
      senderEncoding: false,
    })).toBe("transport");
  });
});

describe("what a stall verdict does", () => {
  test("reconnects on the same codec before blaming it", () => {
    expect(playbackStallAction("codec", null)).toBe("retry-transport");
  });

  test("blames the codec once a stall survives the reconnect", () => {
    expect(playbackStallAction("codec", 0)).toBe("fail-codec");
    expect(playbackStallAction("codec", STALL_RECONNECT_TTL_MS - 1)).toBe("fail-codec");
  });

  test("an old reconnect no longer counts against the codec", () => {
    expect(playbackStallAction("codec", STALL_RECONNECT_TTL_MS)).toBe("retry-transport");
    expect(playbackStallAction("codec", 3 * 60 * 60 * 1000)).toBe("retry-transport");
  });

  test("always retries the transport, whatever the codec did", () => {
    expect(playbackStallAction("transport", null)).toBe("retry-transport");
    expect(playbackStallAction("transport", 0)).toBe("retry-transport");
  });

  test("does nothing when the verdict is to wait", () => {
    expect(playbackStallAction("wait", null)).toBe("none");
  });
});

describe("a rejected offer", () => {
  /// The reported case: the helper had restarted and the route returned before anyone looked.
  test("treats a 404 as worth another try", () => {
    expect(offerFailureIsTransient(404)).toBe(true);
  });

  test("retries the statuses that clear on their own", () => {
    for (const status of [404, 408, 425, 429, 500, 502, 503, 504]) {
      expect(offerFailureIsTransient(status)).toBe(true);
    }
  });

  /// Server-side statuses are all treated as worth retrying; only the client-side
  /// refusals are final, and those are the ones a retry would paper over.
  test("gives up on a request that will never be accepted", () => {
    for (const status of [400, 401, 403, 405, 410]) {
      expect(offerFailureIsTransient(status)).toBe(false);
    }
  });
});
