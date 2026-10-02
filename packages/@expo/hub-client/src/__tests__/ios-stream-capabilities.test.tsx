import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { iosStreamCapabilities, useIosDeviceClient } from '../useIosDevice';
import { type DeviceClient, type DeviceConnectionOptions } from '../types';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();

class Socket {
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
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

async function controlledClient(options: Partial<DeviceConnectionOptions> = {}) {
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
  stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    if (new URL(url).pathname === '/api') {
      return new Promise<Response>((resolve) => discoveries.push(resolve));
    }
    if (url.endsWith('/webrtc/offer')) return Response.json({ type: 'answer', sdp: 'answer' });
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
    resolve: async (index: number, transport: 'http' | 'webrtc' | undefined) => {
      await act(async () =>
        discoveries[index]!(
          Response.json({
            url: 'https://hub.test/helper/device-1',
            device: 'device-1',
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

test('exhausted WebRTC codecs report an error without attempting locked HTTP streams', async () => {
  const hub = await controlledClient({ streamMode: 'webrtc' });
  const deadlines = new Map<number, () => void>();
  let timerId = 0;
  stubGlobal('window', {
    ...window,
    setTimeout(callback: () => void) {
      deadlines.set(++timerId, callback);
      return timerId;
    },
    clearTimeout(id: number) {
      deadlines.delete(id);
    },
  });
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  stubGlobal(
    'RTCPeerConnection',
    class {
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
  );
  await hub.resolve(0, 'webrtc');
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(deadlines.size).toBe(1);
    await act(async () => {
      const [id, callback] = [...deadlines][0]!;
      deadlines.delete(id);
      callback();
    });
  }
  expect(hub.requests.filter((url) => url.endsWith('/webrtc/offer'))).toHaveLength(3);
  expect(hub.client.videoKind).toBe('video');
  expect(hub.client.status).toBe('error');
  expect(hub.client.error).toContain('No supported WebRTC codec');
  expect(hub.requests.some((url) => /stream\.(mjpeg|avcc)/.test(url))).toBe(false);
});
