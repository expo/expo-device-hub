import { describe, expect, test } from "bun:test";
import {
  closeWebRtcSession,
  WebRtcSignalingBusyError,
  WebRtcSignalingTimeoutError,
  postWebRtcOffer,
} from "../client/webrtc-negotiation";

/// A body that sends part of its JSON and then stops, ending only when the request is aborted.
const stalledBody = (signal: AbortSignal) => new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('{"error":'));
    signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
  },
});

describe("WebRTC offer negotiation", () => {
  test("uses a fresh request deadline after a busy response", async () => {
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
        return new Response(null, { status: requests === 1 ? 409 : 200 });
      },
    });

    expect(response.status).toBe(200);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  test("reports serialized signaling contention after exhausting busy retries", async () => {
    await expect(postWebRtcOffer({
      url: "https://example.test/webrtc/offer",
      body: "{}",
      requestTimeoutMs: 100,
      busyRetryIntervalMs: 0,
      busyRetryCount: 1,
      fetchImpl: async () => new Response(null, { status: 409 }),
    })).rejects.toBeInstanceOf(WebRtcSignalingBusyError);
  });

  /// The server also answers 409 for reasons that never clear, such as a device with no panel
  /// streams. Retrying those holds a locked session in a loop, so only contention is retried.
  test("returns a 409 that names a lasting reason instead of retrying it", async () => {
    for (const error of ["panel_streams_unsupported", "stream_transport_locked"]) {
      let requests = 0;
      const response = await postWebRtcOffer({
        url: "https://example.test/webrtc/offer",
        body: "{}",
        requestTimeoutMs: 100,
        busyRetryIntervalMs: 0,
        busyRetryCount: 3,
        fetchImpl: async () => {
          requests++;
          return new Response(JSON.stringify({ error }), { status: 409 });
        },
      });
      expect(response.status).toBe(409);
      expect(requests).toBe(1);
    }
  });

  /// Headers arrive before the body. A 409 whose body stalls has to stay under the request's
  /// own deadline, or negotiation waits on it forever.
  test("gives up on a 409 whose body never finishes", async () => {
    await expect(postWebRtcOffer({
      url: "https://example.test/webrtc/offer",
      body: "{}",
      requestTimeoutMs: 50,
      busyRetryIntervalMs: 0,
      busyRetryCount: 3,
      fetchImpl: async (_url, init) => new Response(stalledBody(init?.signal as AbortSignal), { status: 409 }),
    })).rejects.toBeInstanceOf(WebRtcSignalingTimeoutError);
  }, 1_000);

  test("stops reading a stalled 409 body when the caller aborts", async () => {
    const lifecycle = new AbortController();
    const read = postWebRtcOffer({
      url: "https://example.test/webrtc/offer",
      body: "{}",
      signal: lifecycle.signal,
      requestTimeoutMs: 10_000,
      busyRetryIntervalMs: 0,
      busyRetryCount: 3,
      fetchImpl: async (_url, init) => new Response(stalledBody(init?.signal as AbortSignal), { status: 409 }),
    });
    setTimeout(() => lifecycle.abort(), 20);
    await expect(read).rejects.toThrow();
  }, 1_000);

  test("retries a 409 that names signaling contention", async () => {
    let requests = 0;
    const response = await postWebRtcOffer({
      url: "https://example.test/webrtc/offer",
      body: "{}",
      requestTimeoutMs: 100,
      busyRetryIntervalMs: 0,
      busyRetryCount: 3,
      fetchImpl: async () => {
        requests++;
        return requests < 3
          ? new Response(JSON.stringify({ error: "webrtc_session_busy" }), { status: 409 })
          : new Response(null, { status: 200 });
      },
    });
    expect(response.status).toBe(200);
    expect(requests).toBe(3);
  });

  test("reports a timeout for the individual signaling request", async () => {
    await expect(postWebRtcOffer({
      url: "https://example.test/webrtc/offer",
      body: "{}",
      requestTimeoutMs: 5,
      busyRetryIntervalMs: 0,
      busyRetryCount: 0,
      fetchImpl: async (_url, init) => {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
        return new Response(null, { status: 200 });
      },
    })).rejects.toBeInstanceOf(WebRtcSignalingTimeoutError);
  });

  test("gives a close a deadline, so a reconnect behind it cannot wait forever", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    await closeWebRtcSession({
      url: "https://example.test/webrtc/close",
      sessionId: "session-1",
      fetchImpl: async (_url, init) => {
        signals.push(init?.signal ?? undefined);
        return new Response(null, { status: 204 });
      },
    });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  /// Nothing waits on an unload close, and a deadline could only cut it short.
  test("leaves an unload close without one", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    await closeWebRtcSession({
      url: "https://example.test/webrtc/close",
      sessionId: "session-1",
      keepalive: true,
      sendBeacon: () => false,
      fetchImpl: async (_url, init) => {
        signals.push(init?.signal ?? undefined);
        return new Response(null, { status: 204 });
      },
    });
    expect(signals[0]).toBeUndefined();
  });

  test("uses a beacon to release an established session during pagehide", async () => {
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
});
