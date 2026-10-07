import { afterEach, expect, spyOn, test } from 'bun:test';
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
  onclose?: (event: Pick<CloseEvent, 'code' | 'reason'>) => void;
  onmessage?: (event: { data: string | ArrayBuffer }) => void;
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  addEventListener() {}
  removeEventListener() {}
  send(data: ArrayBuffer | string) {
    this.sent.push(
      JSON.parse(
        typeof data === 'string'
          ? data
          : new TextDecoder().decode(new Uint8Array(data).subarray(1)),
      ),
    );
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  receive(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
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
  stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (/\/api$/.test(new URL(url).pathname) && !url.includes('/grid/')) {
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
    get discoveryCount() {
      return discoveries.length;
    },
    resolveResponse: async (index: number, response: Response) => {
      await act(async () => discoveries[index]!(response));
    },
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
      device = 'device-1',
      extra: Record<string, unknown> = {},
    ) => {
      await act(async () =>
        discoveries[index]!(
          Response.json({
            url: `https://hub.test/helper/${device}`,
            device,
            ...(transport ? { streamSettings: { transport, codec: 'h264' } } : {}),
            ...extra,
          }),
        ),
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

test('a locked session restarts its exhausted ladder with a growing delay', async () => {
  const hub = await exhaustedWebRtcClient();
  const offers = () => hub.requests.filter((url) => url.endsWith('/webrtc/offer'));
  expect(hub.client.status).toBe('error');
  await hub.fireTimer(2000);
  expect(offers()).toHaveLength(4);
  expect(hub.offeredCodecs.at(-1)).toBe('h264');
  expect(hub.client.status).not.toBe('error');
  for (let attempt = 0; attempt < 3; attempt++) await hub.fireTimer(4000);
  expect(offers()).toHaveLength(6);
  expect(hub.client.error).toContain('No supported WebRTC codec');
  // The second restart waits 4 s, not 2 s.
  await hub.fireTimer(4000);
  expect(offers()).toHaveLength(7);
  expect(hub.offeredCodecs.at(-1)).toBe('h264');
});

test('a slow locked walk keeps its restart backoff', async () => {
  let clock = performance.now();
  const now = spyOn(performance, 'now').mockImplementation(() => clock);
  try {
    const hub = await controlledClient({ streamMode: 'webrtc' }, true);
    stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
    stubGlobal('RTCPeerConnection', Peer);
    await hub.resolve(0, 'webrtc');
    const offers = () => hub.requests.filter((url) => url.endsWith('/webrtc/offer')).length;
    const walk = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        clock += 35_000;
        await hub.fireTimer(4000);
      }
    };
    await walk();
    await hub.fireTimer(2000);
    // Codec failures are 35 s apart, so exhaustions are 105 s apart.
    await walk();
    const before = offers();
    await hub.fireTimer(4000);
    expect(offers()).toBe(before + 1);
  } finally {
    now.mockRestore();
  }
});

test('an unchanged background discovery preserves the selected WebRTC codec and peer', async () => {
  const hub = await controlledClient({ streamMode: 'webrtc' }, true);
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  stubGlobal('RTCPeerConnection', Peer);
  await hub.resolve(0, 'webrtc');
  await act(async () => hub.client.setWebRtcCodec('vp9'));
  const offers = [...hub.offeredCodecs];
  await act(async () => Socket.instances.at(-1)!.close());
  await hub.fireTimer(1500);
  expect(hub.client.streamCapabilities?.modeAvailability.webrtc).toBe(true);
  await hub.resolve(1, 'webrtc');
  expect(hub.client.webRtcCodec).toBe('vp9');
  expect(hub.offeredCodecs).toEqual(offers);
});

test('repeated helper failures with unchanged HTTP discovery keep the image stream', async () => {
  const hub = await controlledClient({}, true);
  await hub.resolve(0, 'http');
  let sources = 0;
  let removals = 0;
  const image = {
    set src(_value: string) {
      sources++;
    },
    removeAttribute() {
      removals++;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLImageElement;
  await act(async () => hub.client.attachVideo(image));
  const initialSources = sources;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await act(async () => Socket.instances.at(-1)!.close());
    await hub.fireTimer(1500);
    expect(hub.client.streamCapabilities?.modeAvailability.mjpeg).toBe(true);
    await hub.resolve(attempt, 'http');
    expect(sources).toBe(initialSources);
    expect(removals).toBe(0);
  }
});

async function configChannel() {
  for (const socket of Socket.instances.filter(
    (socket) => socket.url.endsWith('/exec-ws') && socket.readyState !== 3,
  )) {
    await act(async () => {
      socket.open();
      socket.receive({ ready: true });
    });
    const subscription = socket.sent.find(
      (message) => 'path' in message && String(message.path).includes('/api/events'),
    ) as { sub: number; path: string } | undefined;
    if (!subscription) continue;
    return {
      socket,
      path: subscription.path,
      push: async (value: object | null) => {
        await act(async () =>
          socket.receive({ sub: subscription.sub, data: `data: ${JSON.stringify(value)}\n\n` }),
        );
      },
    };
  }
  throw new Error('No config subscription');
}

function preview(transport: 'http' | 'webrtc', extra: Record<string, unknown> = {}) {
  return {
    url: 'https://hub.test/helper/device-1',
    device: 'device-1',
    execToken: 'exec-1',
    streamSettings: { transport, codec: 'h264' },
    ...extra,
  };
}

for (const [before, after] of [
  ['http', 'webrtc'],
  ['webrtc', 'http'],
] as const) {
  test(`exec-ws pushes ${before} to ${after} without another discovery request`, async () => {
    const hub = await controlledClient({}, true);
    await hub.resolveResponse(0, Response.json(preview(before)));
    const channel = await configChannel();
    expect(channel.path).toBe('/api/events?device=device-1');
    await channel.push(preview(before));
    await channel.push(preview(after));
    expect(hub.client.streamCapabilities?.modeAvailability.webrtc).toBe(after === 'webrtc');
    expect(hub.client.videoKind).toBe(after === 'webrtc' ? 'video' : 'img');
    expect(hub.discoveryCount).toBe(1);
  });
}

test('a working config subscription keeps helper reconnects off discovery and preserves the codec', async () => {
  const hub = await controlledClient({ streamMode: 'webrtc' }, true);
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  stubGlobal('RTCPeerConnection', Peer);
  await hub.resolveResponse(0, Response.json(preview('webrtc')));
  const channel = await configChannel();
  await channel.push(preview('webrtc'));
  await act(async () => hub.client.setWebRtcCodec('vp9'));
  const offers = [...hub.offeredCodecs];
  const helper = Socket.instances.find((socket) => socket.url.includes('/helper/ws'))!;
  await act(async () => helper.close());
  await hub.fireTimer(1500);
  await channel.push(preview('webrtc', { streamSettings: { codec: 'h264', transport: 'webrtc' } }));
  expect(hub.client.webRtcCodec).toBe('vp9');
  expect(hub.offeredCodecs).toEqual(offers);
  expect(hub.discoveryCount).toBe(1);
  expect(channel.socket.readyState).toBe(1);
});

test('config updates retain an input rejection until the reconnected helper admits input', async () => {
  const hub = await controlledClient({}, true);
  const config = preview('http', { inputAdmission: true });
  await hub.resolveResponse(0, Response.json(config));
  const channel = await configChannel();
  const helper = Socket.instances.find((socket) => socket.url.includes('/helper/ws'))!;
  const rejection = 'Input client limit reached';
  await act(async () => helper.close(1013, rejection));
  expect(hub.client.inputError).toBe(rejection);
  await channel.push(config);
  expect(hub.client.inputError).toBe(rejection);
  expect(hub.client.streamCapabilities?.modeAvailability).toEqual({
    mjpeg: true,
    h264: true,
    webrtc: false,
  });
  await hub.fireTimer(1500);
  const reconnected = Socket.instances.at(-1)!;
  await act(async () => reconnected.open());
  expect(hub.client.inputError).toBe(rejection);
  await act(async () =>
    reconnected.onmessage?.({ data: new Uint8Array([0x83]).buffer }),
  );
  expect(hub.client.inputError).toBeNull();
  expect(hub.discoveryCount).toBe(1);
});

test('exec-ws recovery replaces rotated credentials without resetting the viewer codec', async () => {
  const hub = await controlledClient({ streamMode: 'webrtc' }, true);
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  stubGlobal('RTCPeerConnection', Peer);
  await hub.resolveResponse(0, Response.json(preview('webrtc')));
  const channel = await configChannel();
  await channel.push(preview('webrtc'));
  await act(async () => hub.client.setWebRtcCodec('vp9'));
  await act(async () => channel.socket.close());
  await hub.fireTimer(1500);
  expect(hub.client.webRtcCodec).toBe('vp9');
  expect(hub.client.streamCapabilities?.modeAvailability.webrtc).toBe(true);
  await hub.resolveResponse(1, Response.json(preview('webrtc', { execToken: 'exec-2' })));
  const replacement = await configChannel();
  expect(replacement.socket.sent).toContainEqual({ token: 'exec-2' });
  expect(hub.client.webRtcCodec).toBe('vp9');
  expect(hub.offeredCodecs.at(-1)).toBe('vp9');
});

test('a missing helper clears capabilities while retaining a subscription for its replacement', async () => {
  const hub = await controlledClient({}, true);
  await hub.resolveResponse(0, Response.json(preview('http')));
  const channel = await configChannel();
  await channel.push(null);
  expect(hub.client.streamCapabilities).toBeNull();
  const replacement = await configChannel();
  await replacement.push(preview('webrtc'));
  expect(hub.client.streamCapabilities?.modeAvailability.webrtc).toBe(true);
  expect(hub.discoveryCount).toBe(1);
});

test('a newer pushed config wins over an in-flight background discovery', async () => {
  const hub = await controlledClient({}, true);
  await hub.resolveResponse(0, Response.json(preview('http')));
  const channel = await configChannel();
  await act(async () => channel.socket.close());
  await hub.fireTimer(1500);
  const replacement = await configChannel();
  await replacement.push(preview('webrtc'));
  await hub.resolveResponse(1, Response.json(preview('http')));
  expect(hub.client.streamCapabilities?.modeAvailability.webrtc).toBe(true);
});

test('encoder updates preserve the viewer codec but a server codec change replaces it', async () => {
  const hub = await controlledClient({ streamMode: 'webrtc' }, true);
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  stubGlobal('RTCPeerConnection', Peer);
  await hub.resolveResponse(
    0,
    Response.json(
      preview('webrtc', {
        streamSettings: {
          transport: 'webrtc',
          codec: 'h264',
          iceServers: [{ urls: ['stun:example.test'] }],
        },
      }),
    ),
  );
  const channel = await configChannel();
  await act(async () => hub.client.setWebRtcCodec('vp9'));
  const offers = [...hub.offeredCodecs];
  await channel.push(
    preview('webrtc', {
      streamSettings: {
        transport: 'webrtc',
        codec: 'h264',
        iceServers: [{ urls: ['stun:example.test'] }],
        h264Bitrate: 8_000_000,
      },
    }),
  );
  expect(hub.client.webRtcCodec).toBe('vp9');
  expect(hub.offeredCodecs).toEqual(offers);
  await channel.push(preview('webrtc', { streamSettings: { transport: 'webrtc', codec: 'vp8' } }));
  expect(hub.client.webRtcCodec).toBe('vp8');
  expect(hub.offeredCodecs.at(-1)).toBe('vp8');
});

test('config subscriptions use the advertised internal mount and requested device', async () => {
  const hub = await controlledClient(
    { baseUrl: 'https://hub.test/public', device: 'device 1' },
    true,
  );
  await hub.resolveResponse(
    0,
    Response.json(preview('http', { basePath: '/internal', proxyHelpers: true })),
  );
  const channel = await configChannel();
  expect(channel.socket.url).toBe('wss://hub.test/public/exec-ws');
  expect(channel.path).toBe('/internal/api/events?device=device%201');
});

test('a failed background discovery retains the HTTP stream and retries', async () => {
  const hub = await controlledClient({}, true);
  await hub.resolve(0, 'http');
  await act(async () => Socket.instances.at(-1)!.close());
  await hub.fireTimer(1500);
  await hub.resolveResponse(1, new Response(null, { status: 503 }));
  expect(hub.client.streamCapabilities?.modeAvailability.mjpeg).toBe(true);
  await hub.fireTimer(1500);
  expect(hub.discoveryCount).toBe(3);
  await hub.resolve(2, 'http');
  expect(hub.client.error).toBeNull();
});

test('a replacement helper PID starts a fresh peer while retaining the viewer codec', async () => {
  const hub = await controlledClient({ streamMode: 'webrtc' }, true);
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  stubGlobal('RTCPeerConnection', Peer);
  await hub.resolveResponse(0, Response.json(preview('webrtc', { pid: 10 })));
  const channel = await configChannel();
  await act(async () => hub.client.setWebRtcCodec('vp9'));
  const offers = hub.offeredCodecs.length;
  await channel.push(preview('webrtc', { pid: 11 }));
  expect(hub.client.webRtcCodec).toBe('vp9');
  expect(hub.offeredCodecs).toHaveLength(offers + 1);
  expect(hub.offeredCodecs.at(-1)).toBe('vp9');
});

test('late config pushes from a previous requested connection are ignored', async () => {
  const hub = await controlledClient({}, true);
  await hub.resolveResponse(0, Response.json(preview('http')));
  const channel = await configChannel();
  await hub.update({ device: 'device-2' });
  await hub.resolve(1, 'webrtc', 'device-2');
  await channel.push(null);
  expect(hub.client.streamCapabilities?.modeAvailability.webrtc).toBe(true);
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
    expect(hub.client.streamCapabilities?.modeAvailability.webrtc).toBe(before === 'webrtc');
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
