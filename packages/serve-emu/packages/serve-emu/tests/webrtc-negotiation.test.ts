import { describe, expect, test } from "bun:test";
import {
  WebRtcSignalingBusyError,
  WebRtcSignalingTimeoutError,
  closeWebRtcSession,
  postWebRtcOffer,
} from "../src/ui/lib/webrtc-negotiation.ts";

describe("WebRTC browser signaling", () => {
  test("retries while the server reports serialized signaling contention", async () => {
    let attempts = 0;
    const response = await postWebRtcOffer({
      url: "https://example.test/webrtc/offer",
      body: "{}",
      requestTimeoutMs: 100,
      busyRetryIntervalMs: 0,
      busyRetryCount: 2,
      fetchImpl: async () => new Response(null, { status: attempts++ === 0 ? 409 : 200 }),
    });

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  test("reports a timeout for a single signaling request", async () => {
    await expect(
      postWebRtcOffer({
        url: "https://example.test/webrtc/offer",
        body: "{}",
        requestTimeoutMs: 1,
        busyRetryIntervalMs: 0,
        busyRetryCount: 0,
        fetchImpl: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      }),
    ).rejects.toBeInstanceOf(WebRtcSignalingTimeoutError);
  });

  test("reports exhausted signaling contention as recoverable busy state", async () => {
    await expect(
      postWebRtcOffer({
        url: "https://example.test/webrtc/offer",
        body: "{}",
        requestTimeoutMs: 100,
        busyRetryIntervalMs: 0,
        busyRetryCount: 1,
        fetchImpl: async () => new Response(null, { status: 409 }),
      }),
    ).rejects.toBeInstanceOf(WebRtcSignalingBusyError);
  });

  test("uses sendBeacon for unload-time session close when available", async () => {
    let fetchCalled = false;
    let beaconBody = "";
    await closeWebRtcSession({
      url: "https://example.test/webrtc/close",
      sessionId: "00000000-0000-4000-8000-000000000000",
      keepalive: true,
      sendBeacon: (_url, body) => {
        beaconBody = body instanceof Blob ? body.type : String(body);
        return true;
      },
      fetchImpl: async () => {
        fetchCalled = true;
        return new Response(null, { status: 204 });
      },
    });

    expect(fetchCalled).toBe(false);
    expect(beaconBody).toBe("text/plain;charset=utf-8");
  });
});
