import { describe, expect, test } from "bun:test";
import { WEBRTC_ICE_TRANSPORT_POLICY } from "../client/webrtc-ice";

describe("WEBRTC_ICE_TRANSPORT_POLICY", () => {
  test("allows direct candidates and uses TURN only as ICE fallback", () => {
    expect(WEBRTC_ICE_TRANSPORT_POLICY).toBe("all");
  });
});
