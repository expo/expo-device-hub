import { describe, expect, test } from 'bun:test';

import {
  closeWebRtcSession,
  postWebRtcOffer,
  WebRtcSignalingBusyError,
  WebRtcSignalingTimeoutError,
} from '../webrtc-negotiation';

describe('WebRTC offer negotiation', () => {
  test('uses a fresh deadline after a busy response', async () => {
    const signals: AbortSignal[] = [];
    let requests = 0;
    const response = await postWebRtcOffer({
      url: 'https://example.test/webrtc/offer',
      body: '{}',
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

  test('reports exhausted offer contention', async () => {
    await expect(
      postWebRtcOffer({
        url: 'https://example.test/webrtc/offer',
        body: '{}',
        requestTimeoutMs: 100,
        busyRetryIntervalMs: 0,
        busyRetryCount: 1,
        fetchImpl: async () => new Response(null, { status: 409 }),
      }),
    ).rejects.toBeInstanceOf(WebRtcSignalingBusyError);
  });

  test('reports an individual signaling timeout', async () => {
    await expect(
      postWebRtcOffer({
        url: 'https://example.test/webrtc/offer',
        body: '{}',
        requestTimeoutMs: 5,
        busyRetryIntervalMs: 0,
        busyRetryCount: 0,
        fetchImpl: async (_url, init) => {
          await new Promise<void>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          });
          return new Response(null, { status: 200 });
        },
      }),
    ).rejects.toBeInstanceOf(WebRtcSignalingTimeoutError);
  });

  test('uses a beacon to release a session during pagehide', async () => {
    let fetched = false;
    const beaconBodies: Blob[] = [];
    await closeWebRtcSession({
      url: 'https://example.test/webrtc/close',
      sessionId: 'session-1',
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
    expect(await beaconBodies[0]!.text()).toBe(JSON.stringify({ sessionId: 'session-1' }));
  });
});

describe('WebRTC signaling with a serve-sim access token', () => {
  test('sends the offer with a bearer', async () => {
    let authorization: string | null = null;
    await postWebRtcOffer({
      url: 'https://example.test/webrtc/offer',
      body: '{}',
      accessToken: 'secret',
      requestTimeoutMs: 100,
      busyRetryIntervalMs: 0,
      busyRetryCount: 0,
      fetchImpl: async (_url, init) => {
        authorization = new Headers(init?.headers).get('authorization');
        return new Response(null, { status: 200 });
      },
    });
    expect(authorization).toBe('Bearer secret');
  });

  test('closes with a bearer, or with the token in the beacon query', async () => {
    let authorization: string | null = null;
    await closeWebRtcSession({
      url: 'https://example.test/webrtc/close',
      sessionId: 'session',
      accessToken: 'secret',
      fetchImpl: async (_url, init) => {
        authorization = new Headers(init?.headers).get('authorization');
        return new Response(null, { status: 200 });
      },
    });
    expect(authorization).toBe('Bearer secret');

    const beacons: string[] = [];
    await closeWebRtcSession({
      url: 'https://example.test/webrtc/close',
      sessionId: 'session',
      keepalive: true,
      accessToken: 'secret',
      sendBeacon: (url) => {
        beacons.push(String(url));
        return true;
      },
      fetchImpl: async () => {
        throw new Error('beacon should have handled the close');
      },
    });
    // A beacon has no headers, and this is the form the serve-sim gate accepts for it.
    expect(beacons).toEqual(['https://example.test/webrtc/close?token=secret']);
  });

  test('leaves the requests untouched without a token', async () => {
    const headers: Array<string | null> = [];
    const beacons: string[] = [];
    await postWebRtcOffer({
      url: 'https://example.test/webrtc/offer',
      body: '{}',
      requestTimeoutMs: 100,
      busyRetryIntervalMs: 0,
      busyRetryCount: 0,
      fetchImpl: async (_url, init) => {
        headers.push(new Headers(init?.headers).get('authorization'));
        return new Response(null, { status: 200 });
      },
    });
    await closeWebRtcSession({
      url: 'https://example.test/webrtc/close',
      sessionId: 'session',
      keepalive: true,
      sendBeacon: (url) => {
        beacons.push(String(url));
        return true;
      },
    });
    expect(headers).toEqual([null]);
    expect(beacons).toEqual(['https://example.test/webrtc/close']);
  });
});
