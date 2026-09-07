import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useAndroidDeviceClient } from '../useAndroidDevice';
import type { DeviceClient, DeviceStreamSourceStatus } from '../types';

class Peer extends EventTarget {
  static instances: Peer[] = [];
  closed = false;
  iceGatheringState = 'complete';
  connectionState = 'connected';
  localDescription: RTCSessionDescriptionInit | null = null;
  ontrack: ((event: { streams: object[]; track: object }) => void) | null = null;

  constructor() {
    super();
    Peer.instances.push(this);
  }

  addTransceiver() {
    return {};
  }
  async createOffer() {
    return { type: 'offer' as const, sdp: 'offer' };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }
  async setRemoteDescription() {}
  close() {
    this.closed = true;
  }
  deliverTrack() {
    this.ontrack?.({ streams: [new browser.MediaStream()], track: {} });
  }
}

class ControlSocket {
  static instances: ControlSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor() {
    ControlSocket.instances.push(this);
  }
  send() {}
  close() {}
}

const source = (sessionGeneration: number): DeviceStreamSourceStatus & { ok: true } => ({
  ok: true,
  mode: sessionGeneration === 1 ? 'scrcpy' : 'grpc-screenshot',
  grpcImageMode: 'mmap',
  inputSource: 'scrcpy',
  availableInputSources: ['scrcpy', 'grpc'],
  availableModes: ['scrcpy', 'grpc-screenshot'],
  sessionGeneration,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let browser: Window;
let root: Root;
let client: DeviceClient;
let video: HTMLVideoElement;
let metadata: ReturnType<typeof deferred<Response>>;
let replacement: ReturnType<typeof deferred<Response>>;
let authoritative: ReturnType<typeof source>;
let puts: number;
let offers: number;
type Timer = { callback: () => void; delay: number };
const intervals = new Map<number, Timer>();
const timeouts = new Map<number, Timer>();
const restoreGlobals: (() => void)[] = [];

function installGlobal(name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  restoreGlobals.push(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  });
}

beforeEach(() => {
  browser = new Window();
  installGlobal('window', browser);
  installGlobal('document', browser.document);
  installGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  installGlobal('RTCPeerConnection', Peer);
  installGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  installGlobal('WebSocket', ControlSocket);
  Peer.instances = [];
  ControlSocket.instances = [];
  metadata = deferred<Response>();
  replacement = deferred<Response>();
  authoritative = source(1);
  puts = 0;
  offers = 0;
  intervals.clear();
  timeouts.clear();
  let timerId = 0;
  installGlobal('setInterval', (callback: () => void, delay: number) => {
    intervals.set(++timerId, { callback, delay });
    return timerId;
  });
  installGlobal('clearInterval', (id: number) => intervals.delete(id));
  installGlobal('setTimeout', (callback: () => void, delay: number) => {
    timeouts.set(++timerId, { callback, delay });
    return timerId;
  });
  installGlobal('clearTimeout', (id: number) => timeouts.delete(id));
  let initialSourceRead = true;
  installGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api') {
      return Response.json({
        stream: {
          transport: 'webrtc',
          codec: 'h264',
          iceServers: [],
          iceTransportPolicy: 'all',
        },
      });
    }
    if (path === '/api/stream-mode') {
      if (init?.method === 'PUT') {
        puts++;
        return replacement.promise;
      }
      if (initialSourceRead) {
        initialSourceRead = false;
        return metadata.promise;
      }
      return Response.json(authoritative);
    }
    if (path === '/webrtc/offer') {
      offers++;
      return Response.json({ type: 'answer', sdp: 'answer' });
    }
    return Response.json({});
  });
  root = createRoot(document.createElement('div'));
  video = document.createElement('video');
  Object.defineProperties(video, {
    videoWidth: { value: 1080 },
    videoHeight: { value: 1920 },
    play: { value: async () => {} },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const restore of restoreGlobals.splice(0).reverse()) restore();
});

function Harness() {
  client = useAndroidDeviceClient({
    baseUrl: 'http://device.test',
    device: 'emulator-5554',
    streamMode: 'webrtc',
  });
  return null;
}

async function mount() {
  await act(async () => root.render(<Harness />));
  expect(offers).toBe(1);
  await act(async () => {
    metadata.resolve(Response.json(authoritative));
    client.attachVideo(video);
    ControlSocket.instances[0].onopen?.();
    Peer.instances[0].deliverTrack();
  });
  await paintFrame();
  expect(client.status).toBe('streaming');
  // Initial source metadata must not replace the already connecting peer.
  expect(offers).toBe(1);
  expect(Peer.instances).toHaveLength(1);
}

async function paintFrame() {
  await act(async () => video.dispatchEvent(new window.Event('loadeddata')));
}

async function confirmReplacement(generation = 2) {
  authoritative = source(generation);
  await act(async () => replacement.resolve(Response.json(authoritative)));
}

async function reconnectControl() {
  const entry = [...timeouts].find(([, timer]) => timer.delay === 100);
  if (!entry) throw new Error('The control socket did not schedule a reconnect');
  timeouts.delete(entry[0]);
  await act(async () => entry[1].callback());
}

describe('Android WebRTC capture replacement hooks', () => {
  test('restarts once on confirmation and keeps the replacement peer when its frame commits', async () => {
    await mount();
    await act(async () => client.setStreamSource('grpc-screenshot'));
    expect(client.streamSourcePending).toBe(true);
    expect(offers).toBe(1);

    await confirmReplacement();
    expect(offers).toBe(2);
    expect(Peer.instances).toHaveLength(2);
    expect(Peer.instances[0].closed).toBe(true);
    expect(client.streamSource?.sessionGeneration).toBe(1);
    expect(client.streamSourcePending).toBe(true);
    await act(async () => Peer.instances[1].deliverTrack());
    expect(client.streamSourcePending).toBe(true);
    await paintFrame();
    expect(client.streamSource?.sessionGeneration).toBe(2);
    expect(client.streamSourcePending).toBe(false);
    expect(client.status).toBe('streaming');
    expect(offers).toBe(2);
    expect(Peer.instances).toHaveLength(2);
    expect(Peer.instances[1].closed).toBe(false);
  });

  test.each(['before', 'with'] as const)(
    'keeps controls pending if the control socket recovers %s the PUT response',
    async (timing) => {
      await mount();
      await act(async () => client.setStreamSource('grpc-screenshot'));
      await act(async () => ControlSocket.instances[0].onclose?.({ code: 1012 }));
      expect(client.status).toBe('reconnecting');
      await reconnectControl();
      if (timing === 'before') {
        await act(async () => ControlSocket.instances[1].onopen?.());
        expect(client.status).toBe('streaming');
        await confirmReplacement();
      } else {
        await act(async () => {
          ControlSocket.instances[1].onopen?.();
          replacement.resolve(Response.json(source(2)));
        });
      }
      expect(offers).toBe(2);
      expect(client.status).toBe('reconnecting');
      expect(client.streamSourcePending).toBe(true);
      expect(client.streamSource?.sessionGeneration).toBe(1);
      await act(async () => {
        client.setStreamSource('grpc-screenshot');
        client.setStreamSource('scrcpy');
      });
      expect(puts).toBe(1);

      await act(async () => Peer.instances[1].deliverTrack());
      expect(client.streamSourcePending).toBe(true);
      await paintFrame();
      expect(client.streamSourcePending).toBe(false);
      expect(client.streamSource?.sessionGeneration).toBe(2);
      expect(offers).toBe(2);
    },
  );

  test.each(['failed', 'unchanged'] as const)(
    'preserves the peer when the PUT is %s',
    async (result) => {
      await mount();
      await act(async () => client.setStreamSource('grpc-screenshot'));
      await act(async () =>
        replacement.resolve(
          result === 'failed'
            ? Response.json({ error: 'Capture unavailable' }, { status: 503 })
            : Response.json(source(1)),
        ),
      );
      expect(client.streamSourcePending).toBe(false);
      expect(client.streamSource?.sessionGeneration).toBe(1);
      expect(client.status).toBe('streaming');
      expect(offers).toBe(1);
      expect(Peer.instances).toHaveLength(1);
      expect(Peer.instances[0].closed).toBe(false);
      if (result === 'failed') expect(client.streamSourceError).toContain('Capture unavailable');
    },
  );

  test('waits for the replacement frame when changing the gRPC image mode', async () => {
    authoritative = source(2);
    await mount();
    await act(async () => client.setGrpcImageMode('png'));
    await act(async () =>
      replacement.resolve(
        Response.json({
          ...source(3),
          grpcImageMode: 'png',
        }),
      ),
    );
    expect(puts).toBe(1);
    expect(offers).toBe(2);
    expect(client.streamSource?.grpcImageMode).toBe('mmap');
    expect(client.streamSourcePending).toBe(true);
    await act(async () => Peer.instances[1].deliverTrack());
    await paintFrame();
    expect(client.streamSource?.grpcImageMode).toBe('png');
    expect(client.streamSourcePending).toBe(false);
    expect(offers).toBe(2);
    expect(Peer.instances).toHaveLength(2);
  });

  test('restarts once per polled generation change, including a server reset', async () => {
    await mount();
    for (const [generation, expectedOffers] of [
      [2, 2],
      [2, 2],
      [0, 3],
    ]) {
      authoritative = source(generation);
      await act(async () => {
        for (const timer of intervals.values()) {
          if (timer.delay === 3000) timer.callback();
        }
      });
      expect(client.streamSource?.sessionGeneration).toBe(generation);
      expect(offers).toBe(expectedOffers);
      expect(Peer.instances).toHaveLength(expectedOffers);
    }
  });
});
