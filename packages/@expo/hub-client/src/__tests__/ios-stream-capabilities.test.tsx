import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { iosStreamCapabilities, useIosDeviceClient } from '../useIosDevice';
import { type DeviceClient, type DeviceConnectionOptions } from '../types';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  sent: object[] = [];
  onopen?: () => void;
  onclose?: () => void;
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  addEventListener() {}
  removeEventListener() {}
  send(data: ArrayBuffer) {
    this.sent.push(JSON.parse(new TextDecoder().decode(new Uint8Array(data).subarray(1))));
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

class Peer {
  iceGatheringState = 'complete';
  connectionState = 'connected';
  localDescription = { type: 'offer', sdp: 'offer' };
  ontrack?: (event: { streams: object[]; track: object }) => void;
  onconnectionstatechange?: () => void;
  addTransceiver() {
    return {};
  }
  async createOffer() {
    return this.localDescription;
  }
  async setLocalDescription() {}
  async setRemoteDescription() {
    this.onconnectionstatechange?.();
    this.ontrack?.({ streams: [{}], track: {} });
  }
  async getStats() {
    return new Map();
  }
  close() {}
}

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  Socket.instances = [];
  restoreGlobals();
});

test('an HTTP serve-sim offers MJPEG and H.264 but not WebRTC', () => {
  for (const settings of [
    undefined,
    null,
    {},
    { transport: 'http' },
    { transport: 'http', codec: 'mjpeg' },
  ]) {
    expect(iosStreamCapabilities(settings)).toEqual({
      modeAvailability: { mjpeg: true, h264: true, webrtc: false },
      httpCodecs: ['auto', 'h264', 'mjpeg'],
      webRtcCodecs: [],
    });
  }
});

test('a WebRTC serve-sim offers only WebRTC', () => {
  expect(iosStreamCapabilities({ transport: 'webrtc', codec: 'vp9' })).toEqual({
    modeAvailability: { mjpeg: false, h264: false, webrtc: true },
    httpCodecs: [],
    webRtcCodecs: ['h264', 'vp9', 'vp8'],
  });
});

for (const { transport, webrtc } of [
  { transport: undefined, webrtc: false },
  { transport: 'http', webrtc: false },
  { transport: 'webrtc', webrtc: true },
] as const) {
  test(`iOS client reports WebRTC=${webrtc} for /api transport ${transport ?? '(none)'}`, async () => {
    const hub = await controlledClient();
    await hub.resolve(0, transport);
    expect(hub.client.streamCapabilities?.modeAvailability).toEqual({
      mjpeg: !webrtc,
      h264: !webrtc,
      webrtc,
    });
  });
}

async function controlledClient(
  options: Partial<DeviceConnectionOptions> = {},
  fakeTimers = false
) {
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  const schedule = (callback: () => void, delay: number) => {
    timers.set(++timerId, { callback, delay });
    return timerId;
  };
  const cancel = (id: number) => {
    timers.delete(id);
  };
  if (fakeTimers) {
    stubGlobal('setTimeout', schedule);
    stubGlobal('clearTimeout', cancel);
  }
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', {
    location: { href: 'https://hub.test/' },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal('WebSocket', Socket);
  // Missing WebRTC is a permanent failure. A WebRTC-only server must retain
  // that error rather than attempt HTTP streams that the server refuses.
  stubGlobal('RTCPeerConnection', undefined);
  const discoveries: Array<(response: Response) => void> = [];
  const requests: string[] = [];
  const offeredCodecs: string[] = [];
  stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    requests.push(url);
    if (new URL(url).pathname === '/api') {
      return new Promise<Response>((resolve) => discoveries.push(resolve));
    }
    if (url.endsWith('/webrtc/offer')) {
      offeredCodecs.push(JSON.parse(String(init?.body)).codec);
      return Response.json({ type: 'answer', sdp: 'answer' });
    }
    return Response.json({}, { status: 404 });
  });
  let client!: DeviceClient;
  function Harness({ connection }: { connection: Partial<DeviceConnectionOptions> }) {
    client = useIosDeviceClient({
      baseUrl: 'https://hub.test',
      device: 'device-1',
      streamMode: 'mjpeg',
      ...connection,
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness connection={options} />);
  });
  return {
    get client() {
      return client;
    },
    requests,
    offeredCodecs,
    fireTimer: async (delay: number) => {
      const matching = [...timers].filter(([, timer]) => timer.delay === delay);
      expect(matching.length).toBeGreaterThan(0);
      await act(async () => {
        for (const [id, timer] of matching) {
          timers.delete(id);
          timer.callback();
        }
      });
    },
    resolve: async (
      index: number,
      transport: 'http' | 'webrtc' | undefined,
      device = 'device-1'
    ) => {
      await act(async () =>
        discoveries[index]!(
          Response.json({
            url: `https://hub.test/helper/${device}`,
            device,
            ...(transport ? { streamSettings: { transport, codec: 'h264' } } : {}),
          })
        )
      );
    },
    update: async (connection: Partial<DeviceConnectionOptions>) => {
      await act(async () => renderer!.update(<Harness connection={connection} />));
    },
  };
}

test('iOS stream capabilities stay unknown until discovery completes and clear on disconnect', async () => {
  const hub = await controlledClient();
  expect(hub.client.streamCapabilities).toBeNull();
  await hub.resolve(0, 'http');
  expect(hub.client.streamCapabilities?.modeAvailability.webrtc).toBe(false);
  await hub.update({ enabled: false });
  expect(hub.client.streamCapabilities).toBeNull();
});

for (const connection of [{ baseUrl: 'https://another.test' }, { device: 'device-2' }]) {
  test(`iOS capabilities reset while discovering a new ${'baseUrl' in connection ? 'server' : 'device'}`, async () => {
    const hub = await controlledClient();
    await hub.resolve(0, 'http');
    await hub.update(connection);
    expect(hub.client.streamCapabilities).toBeNull();
    await hub.resolve(1, 'webrtc');
    expect(hub.client.streamCapabilities?.modeAvailability).toEqual({
      mjpeg: false,
      h264: false,
      webrtc: true,
    });
  });
}

test('late discovery from a previous server cannot overwrite current capabilities', async () => {
  const hub = await controlledClient();
  await hub.update({ baseUrl: 'https://another.test' });
  await hub.resolve(1, 'webrtc');
  await hub.resolve(0, 'http');
  expect(hub.client.streamCapabilities?.modeAvailability.webrtc).toBe(true);
});

for (const streamMode of ['mjpeg', 'h264', 'webrtc'] as const) {
  test(`WebRTC-only iOS servers use video for requested ${streamMode} and never fall back to HTTP`, async () => {
    const hub = await controlledClient({ streamMode });
    await hub.resolve(0, 'webrtc');
    expect(hub.client.videoKind).toBe('video');
    expect(hub.client.status).toBe('error');
    expect(hub.client.error).toContain('WebRTC');
    expect(hub.requests.some((url) => /stream\.(mjpeg|avcc)/.test(url))).toBe(false);
  });
}

test('HTTP-only iOS servers replace a requested WebRTC stream with an HTTP surface', async () => {
  const hub = await controlledClient({ streamMode: 'webrtc' });
  let peers = 0;
  stubGlobal(
    'RTCPeerConnection',
    class {
      constructor() {
        peers++;
        throw new Error('Unexpected WebRTC connection');
      }
    }
  );
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  await hub.resolve(0, 'http');
  expect(hub.client.videoKind).toBe('img');
  expect(hub.client.error).toBeNull();
  expect(peers).toBe(0);
  expect(hub.requests.some((url) => url.endsWith('/webrtc/offer'))).toBe(false);
});

async function exhaustedWebRtcClient() {
  const hub = await controlledClient({ streamMode: 'webrtc' }, true);
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  stubGlobal('RTCPeerConnection', Peer);
  await hub.resolve(0, 'webrtc');
  for (let attempt = 0; attempt < 3; attempt++) await hub.fireTimer(4000);
  return hub;
}

test('exhausted WebRTC codecs report an error without attempting locked HTTP streams', async () => {
  const hub = await exhaustedWebRtcClient();
  expect(hub.requests.filter((url) => url.endsWith('/webrtc/offer'))).toHaveLength(3);
  expect(hub.client.videoKind).toBe('video');
  expect(hub.client.status).toBe('error');
  expect(hub.client.error).toContain('No supported WebRTC codec');
  expect(hub.requests.some((url) => /stream\.(mjpeg|avcc)/.test(url))).toBe(false);
});

for (const [before, after] of [
  ['http', 'webrtc'],
  ['webrtc', 'http'],
] as const) {
  test(`an iOS helper disconnect rediscovers ${before} to ${after} at the same server/device`, async () => {
    const hub = await controlledClient({}, true);
    await hub.resolve(0, before);
    await act(async () => Socket.instances.at(-1)!.close());
    await hub.fireTimer(1500);
    expect(hub.client.streamCapabilities).toBeNull();
    expect(hub.requests.filter((url) => new URL(url).pathname === '/api')).toHaveLength(2);
    await hub.resolve(1, after);
    expect(hub.client.streamCapabilities?.modeAvailability.webrtc).toBe(after === 'webrtc');
    expect(hub.client.videoKind).toBe(after === 'webrtc' ? 'video' : 'img');
    expect(Socket.instances).toHaveLength(2);
  });
}

test('selecting the failed final WebRTC codec sends a new offer and clears its terminal error', async () => {
  const hub = await exhaustedWebRtcClient();
  expect(hub.offeredCodecs).toEqual(['h264', 'vp8', 'vp9']);
  await act(async () => hub.client.setWebRtcCodec('vp9'));
  expect(hub.offeredCodecs).toEqual(['h264', 'vp8', 'vp9', 'vp9']);
  expect(hub.client.error).toBeNull();
  expect(hub.requests.filter((url) => new URL(url).pathname === '/api')).toHaveLength(1);
  // Exhaust the user's new VP9 → VP8 preference, then retry unchanged VP8.
  await hub.fireTimer(4000);
  await hub.fireTimer(4000);
  await act(async () => hub.client.setWebRtcCodec('vp8'));
  expect(hub.offeredCodecs.slice(-2)).toEqual(['vp8', 'vp8']);
  await hub.fireTimer(4000);
  expect(hub.client.status).toBe('error');
  await act(async () => hub.client.setWebRtcCodec('vp8'));
  expect(hub.offeredCodecs.slice(-2)).toEqual(['vp8', 'vp8']);
  expect(hub.offeredCodecs).toHaveLength(7);
  expect(hub.client.error).toBeNull();
});

test('fresh input queued during rediscovery is delivered to the same device', async () => {
  const hub = await controlledClient({}, true);
  await hub.resolve(0, 'http');
  await act(async () => Socket.instances.at(-1)!.close());
  hub.client.pressButton('home');
  await hub.fireTimer(1500);
  await hub.resolve(1, 'http');
  const replacement = Socket.instances.at(-1)!;
  await act(async () => replacement.open());
  expect(replacement.sent).toContainEqual({ button: 'home' });
});

test('queued input is discarded when rediscovery resolves to a different device', async () => {
  const hub = await controlledClient({ device: undefined }, true);
  await hub.resolve(0, 'http');
  await act(async () => Socket.instances.at(-1)!.close());
  hub.client.pressButton('home');
  await hub.fireTimer(1500);
  await hub.resolve(1, 'http', 'device-2');
  const replacement = Socket.instances.at(-1)!;
  await act(async () => replacement.open());
  expect(replacement.sent).not.toContainEqual({ button: 'home' });
});

for (const connection of [
  { baseUrl: 'https://another.test' },
  { device: 'device-2' },
  { enabled: false },
]) {
  test(`queued input is discarded when the requested connection changes to ${JSON.stringify(connection)}`, async () => {
    const hub = await controlledClient({}, true);
    await hub.resolve(0, 'http');
    await act(async () => Socket.instances.at(-1)!.close());
    hub.client.pressButton('home');
    await hub.update(connection);
    if ('enabled' in connection) await hub.update({ enabled: true });
    // Even if discovery advertises the same helper, input belongs to the old
    // requested connection and must not be replayed on this one.
    await hub.resolve(1, 'http');
    const replacement = Socket.instances.at(-1)!;
    await act(async () => replacement.open());
    expect(replacement.sent).not.toContainEqual({ button: 'home' });
  });
}
