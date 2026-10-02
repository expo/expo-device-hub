import { describe, expect, test } from "bun:test";

import {
  closeWebRtcSession,
  postWebRtcOffer,
  WebRtcSignalingBusyError,
  WebRtcSignalingTimeoutError,
} from '../webrtc-negotiation.js';

describe("WebRTC offer negotiation", () => {
  test("retries serve-emu's coded contention response", async () => {
    let requests = 0;
    const response = await postWebRtcOffer({
      url: "https://example.test/webrtc/offer",
      body: "{}",
      requestTimeoutMs: 100,
      busyRetryIntervalMs: 0,
      busyRetryCount: 1,
      fetchImpl: async () => {
        requests++;
        return requests === 1
          ? Response.json(
              { ok: false, code: "webrtc_session_busy", error: "WebRTC signaling already in progress" },
              { status: 409 },
            )
          : Response.json({ type: "answer", sdp: "answer" });
      },
    });
    expect(response.status).toBe(200);
    expect(requests).toBe(2);
  });

  test("returns a lasting named 409 without retrying it", async () => {
    let requests = 0;
    const response = await postWebRtcOffer({
      url: "https://example.test/webrtc/offer",
      body: "{}",
      requestTimeoutMs: 100,
      busyRetryIntervalMs: 0,
      busyRetryCount: 1,
      fetchImpl: async () => {
        requests++;
        return Response.json({ error: "no_panel_streams" }, { status: 409 });
      },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_panel_streams" });
    expect(requests).toBe(1);
  });

  test("does not retry a permanent serve-emu code without an error message", async () => {
    let requests = 0;
    const response = await postWebRtcOffer({
      url: "https://example.test/webrtc/offer",
      body: "{}",
      requestTimeoutMs: 100,
      busyRetryIntervalMs: 0,
      busyRetryCount: 1,
      fetchImpl: async () => {
        requests++;
        return Response.json({ code: "invalid_offer" }, { status: 409 });
      },
    });
    expect(response.status).toBe(409);
    expect(requests).toBe(1);
  });

  test("the signaling deadline also bounds a stalled 409 body", async () => {
    await expect(
      postWebRtcOffer({
        url: "https://example.test/webrtc/offer",
        body: "{}",
        requestTimeoutMs: 5,
        busyRetryIntervalMs: 0,
        busyRetryCount: 1,
        fetchImpl: async (_url, init) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener(
                  "abort",
                  () => controller.error(init.signal?.reason),
                  { once: true },
                );
              },
            }),
            { status: 409 },
          ),
      }),
    ).rejects.toBeInstanceOf(WebRtcSignalingTimeoutError);
  });

  test("ordinary close aborts a server that never replies", async () => {
    const signals: AbortSignal[] = [];
    await closeWebRtcSession({
      url: "https://example.test/webrtc/close",
      sessionId: "session-1",
      fetchImpl: async (_url, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Missing close deadline");
        signals.push(signal);
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }),
        );
        return new Response(null);
      },
    });
    expect(signals[0]?.aborted).toBe(true);
  });

  test("uses a fresh deadline after a busy response", async () => {
    const signals: AbortSignal[] = [];
    let requests = 0;
    const response = await postWebRtcOffer({
      url: "https://example.test/webrtc/offer",
      body: "{}",
      requestTimeoutMs: 100,
      busyRetryIntervalMs: 0,
      busyRetryCount: 1,
      fetchImpl: async (_url, init) => {
        signals.push(init?.signal as AbortSignal);
        requests++;
        return requests === 1
          ? Response.json({ error: "webrtc_session_busy" }, { status: 409 })
          : new Response(null, { status: 200 });
      },
    });
    expect(response.status).toBe(200);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  test("reports exhausted offer contention", async () => {
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

  test("reports an individual signaling timeout", async () => {
    await expect(
      postWebRtcOffer({
        url: "https://example.test/webrtc/offer",
        body: "{}",
        requestTimeoutMs: 5,
        busyRetryIntervalMs: 0,
        busyRetryCount: 0,
        fetchImpl: async (_url, init) => {
          await new Promise<void>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          });
          return new Response(null, { status: 200 });
        },
      }),
    ).rejects.toBeInstanceOf(WebRtcSignalingTimeoutError);
  });

  test("uses a beacon to release a session during pagehide", async () => {
    let fetched = false;
    const beaconBodies: Blob[] = [];
    await closeWebRtcSession({
      url: "https://example.test/webrtc/close",
      sessionId: "session-1",
      keepalive: true,
      sendBeacon: (_url, body) => {
        beaconBodies.push(body as Blob);
        return true;
      },
      fetchImpl: async () => {
        fetched = true;
        return new Response(null, { status: 204 });
      },
    });
    expect(fetched).toBe(false);
    expect(await beaconBodies[0]!.text()).toBe(JSON.stringify({ sessionId: "session-1" }));
  });

  // A beacon cannot set a header, so only it may carry the token in its URL. Proxy logs record URLs.
  test('sends the beacon URL only to the beacon, and the plain URL to a POST', async () => {
    const beaconUrls: string[] = [];
    const fetchedUrls: string[] = [];
    await closeWebRtcSession({
      url: 'https://example.test/webrtc/close',
      beaconUrl: 'https://example.test/webrtc/close?token=tok-1',
      sessionId: 'session-1',
      keepalive: true,
      sendBeacon: (url) => {
        beaconUrls.push(String(url));
        return false;
      },
      fetchImpl: async (url) => {
        fetchedUrls.push(String(url));
        return new Response(null, { status: 204 });
      },
    });
    expect(beaconUrls).toEqual(['https://example.test/webrtc/close?token=tok-1']);
    expect(fetchedUrls).toEqual(['https://example.test/webrtc/close']);
  });
});
