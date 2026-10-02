import { afterEach, expect, test } from 'bun:test';
import { useLayoutEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { type DeviceClient, type DeviceConnectionOptions } from '../types';
import { useIosDeviceClient } from '../useIosDevice';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
const cleanup: Array<() => void> = [];

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  cleanup.splice(0).forEach((stop) => stop());
  restoreGlobals();
});

type RequestRecord = {
  server: string;
  path: string;
  device: string | null;
  authorization: string | null;
  protocol: string | null;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

// Run the actual hook against real HTTP and native WebSockets. Discovery can
// stay pending while all other routes respond, matching a session handoff.
function server(name: string, received: RequestRecord[]) {
  let discoveryGate: ReturnType<typeof deferred> | null = null;
  const instance = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, transport) {
      const url = new URL(request.url);
      const protocol = request.headers.get('sec-websocket-protocol');
      received.push({
        server: name,
        path: url.pathname,
        device: url.searchParams.get('device'),
        authorization: request.headers.get('authorization'),
        protocol,
      });
      if (request.headers.get('upgrade') === 'websocket') {
        if (
          transport.upgrade(request, {
            headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : {},
          })
        )
          return;
        return new Response(null, { status: 400 });
      }
      if (url.pathname === '/session/api') {
        const gate = discoveryGate;
        discoveryGate = null;
        if (gate) await gate.promise;
        const device = url.searchParams.get('device') ?? 'DEVICE-A';
        return Response.json({
          url: `http://127.0.0.1:0/internal/helper/${device}`,
          device,
          proxyHelpers: true,
          basePath: '/internal',
          execToken: `${name}-exec-token`,
          streamSettingsEndpoint: `/internal/helper/${device}/stream-settings`,
          gridApiEndpoint: '/internal/grid/api',
          streamSettings: { transport: 'webrtc', codec: 'h264', fps: 30 },
        });
      }
      if (url.pathname.endsWith('/stream-settings')) {
        return Response.json({ transport: 'webrtc', codec: 'h264', fps: 30 });
      }
      if (url.pathname.endsWith('/offer')) return Response.json({ type: 'answer', sdp: 'answer' });
      return Response.json({ devices: [], sessions: [] });
    },
    websocket: {
      message(socket, data) {
        if (typeof data !== 'string') return;
        const message = JSON.parse(data);
        if (message.token) socket.send(JSON.stringify({ ready: true }));
        else if (message.id)
          socket.send(JSON.stringify({ id: message.id, status: {}, exitCode: 0 }));
      },
    },
  });
  cleanup.push(() => {
    discoveryGate?.resolve();
    instance.stop(true);
  });
  return {
    baseUrl: `${instance.url.origin}/session`,
    holdDiscovery() {
      const gate = deferred();
      discoveryGate = gate;
      cleanup.push(gate.resolve);
      return gate.resolve;
    },
  };
}

class Peer {
  iceGatheringState = 'complete';
  connectionState = 'connected';
  localDescription = { type: 'offer', sdp: 'offer' };
  addTransceiver() {
    return {};
  }
  async createOffer() {
    return this.localDescription;
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async getStats() {
    return new Map();
  }
  close() {}
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) {
    await act(async () => {
      await Bun.sleep(5);
    });
  }
  expect(predicate()).toBe(true);
}

function setup() {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', {
    location: {
      protocol: 'http:',
      origin: 'http://app.test',
      host: 'app.test',
      href: 'http://app.test/',
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal('navigator', { sendBeacon: () => false });
  stubGlobal('RTCPeerConnection', Peer);
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  let client!: DeviceClient;
  const video = {
    tagName: 'VIDEO',
    readyState: 0,
    videoWidth: 0,
    videoHeight: 0,
    srcObject: null,
    poster: '',
    play: async () => {},
    addEventListener() {},
    removeEventListener() {},
    removeAttribute() {},
  };
  function Harness({ options }: { options: DeviceConnectionOptions }) {
    client = useIosDeviceClient(options);
    const { attachVideo } = client;
    useLayoutEffect(
      () => attachVideo(video as unknown as HTMLVideoElement),
      [attachVideo],
    );
    return null;
  }
  return {
    get client() {
      return client;
    },
    async render(options: DeviceConnectionOptions) {
      await act(async () => {
        if (renderer) renderer.update(<Harness options={options} />);
        else renderer = create(<Harness options={options} />);
      });
    },
  };
}

for (const change of ['server', 'device', 'token'] as const) {
  test(`a ${change} change gates resolved transports until discovery matches the new identity`, async () => {
    const received: RequestRecord[] = [];
    const a = server('A', received);
    const b = server('B', received);
    const harness = setup();
    const initial = {
      baseUrl: a.baseUrl,
      device: 'DEVICE-A',
      token: 'token-A',
      streamMode: 'webrtc' as const,
    };
    await harness.render(initial);
    await waitFor(() => received.some((request) => request.path.endsWith('/offer')));
    await waitFor(() => received.some((request) => request.path.endsWith('/stream-settings')));
    await waitFor(() => received.some((request) => request.path === '/session/exec-ws'));
    await act(async () => harness.client.setStreamStatsEnabled(true));
    await waitFor(() => received.some((request) => request.path.endsWith('/stats')));
    const next = {
      ...initial,
      ...(change === 'server' ? { baseUrl: b.baseUrl, token: 'token-B', device: 'DEVICE-B' } : {}),
      ...(change === 'device' ? { device: 'DEVICE-B' } : {}),
      ...(change === 'token' ? { token: 'token-B' } : {}),
    };
    const release = (change === 'server' ? b : a).holdDiscovery();
    const before = received.length;
    await harness.render(next);
    await waitFor(() => received.slice(before).some((request) => request.path === '/session/api'));
    await waitFor(() => received.slice(before).some((request) => request.path.endsWith('/close')));
    await act(async () => {
      await Bun.sleep(20);
    });
    const duringDiscovery = received.slice(before);
    // The only old-session request is its teardown, with its own credential.
    expect(duringDiscovery.filter((request) => request.path !== '/session/api')).toEqual([
      expect.objectContaining({
        server: 'A',
        path: '/session/helper/DEVICE-A/webrtc/close',
        authorization: 'Bearer token-A',
      }),
    ]);
    expect(harness.client.capabilities.deviceSettings).toBe(false);
    expect(harness.client.capabilities.streamSettings).toBe(false);
    await act(async () => {
      harness.client.setDeviceSetting('appearance', 'dark');
      harness.client.setHardwareKeyboardConnected(true);
      harness.client.sendTouch({ phase: 'begin', x: 10, y: 10 });
    });
    expect(received.slice(before)).toEqual(duringDiscovery);
    release();
    await waitFor(() => harness.client.capabilities.deviceSettings === true);
    await waitFor(() => received.slice(before).some((request) => request.path.endsWith('/offer')));
    const afterDiscovery = received.slice(before + duringDiscovery.length);
    expect(afterDiscovery.length).toBeGreaterThan(0);
    expect(
      afterDiscovery.every((request) => request.server === (change === 'server' ? 'B' : 'A')),
    ).toBe(true);
    expect(
      afterDiscovery.every((request) =>
        request.protocol === null
          ? request.authorization === `Bearer ${next.token}`
          : request.protocol === `serve-sim.token.${next.token}`,
      ),
    ).toBe(true);
    expect(
      afterDiscovery
        .filter((request) => request.path.includes('/helper/'))
        .every(
          (request) =>
            request.path.includes(`/helper/${next.device}/`) || request.device === next.device,
        ),
    ).toBe(true);
  });
}

test('a cancelled discovery cannot restore old credentials after the replacement resolves', async () => {
  const received: RequestRecord[] = [];
  const a = server('A', received);
  const b = server('B', received);
  const releaseA = a.holdDiscovery();
  const harness = setup();
  await harness.render({ baseUrl: a.baseUrl, token: 'token-A', streamMode: 'webrtc' });
  await waitFor(() => received.some((request) => request.server === 'A'));
  await harness.render({ baseUrl: b.baseUrl, token: 'token-B', streamMode: 'webrtc' });
  await waitFor(() =>
    received.some((request) => request.server === 'B' && request.path.endsWith('/offer')),
  );
  const before = received.length;
  releaseA();
  await act(async () => {
    await Bun.sleep(20);
  });
  expect(received.slice(before).filter((request) => request.server === 'A')).toEqual([]);
  expect(harness.client.capabilities.deviceSettings).toBe(true);
});
