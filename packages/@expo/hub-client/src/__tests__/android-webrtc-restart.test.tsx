import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useAndroidDeviceClient } from '../useAndroidDevice.js';
import { DeviceScreen } from '../DeviceScreen.js';
import type { DeviceClient, DeviceStreamSourceStatus } from '../types.js';

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
    if (video?.srcObject) frameVisibleAtClose.push(retainedFrame()?.style.visibility === 'visible');
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
  sent: string[] = [];
  send(message: string) { this.sent.push(message); }
  close() {}
}

const source = (sessionGeneration: number): DeviceStreamSourceStatus & { ok: true } => ({
  ok: true,
  mode: sessionGeneration === 1 ? 'scrcpy' : 'grpc-screenshot',
  grpcImageMode: 'mmap',
  encoder: 'software',
  encoderName: null,
  availableEncoders: ['software'],
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
let container: HTMLDivElement;
let savedFrames: number;
let frameVisibleAtClose: boolean[];
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
  savedFrames = 0;
  frameVisibleAtClose = [];
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
  browser.setTimeout = globalThis.setTimeout as unknown as typeof browser.setTimeout;
  browser.clearTimeout = globalThis.clearTimeout as unknown as typeof browser.clearTimeout;
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
  container = document.createElement('div');
  root = createRoot(container);
  Object.defineProperty(browser.HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({
      drawImage: () => {
        savedFrames++;
      },
    }),
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const restore of restoreGlobals.splice(0).reverse()) restore();
});

function Harness({ device = 'emulator-5554', enabled = true } = {}) {
  client = useAndroidDeviceClient({
    baseUrl: 'http://device.test',
    device,
    enabled,
    streamMode: 'webrtc',
  });
  return <DeviceScreen client={client} />;
}

async function mount() {
  await act(async () => root.render(<Harness />));
  expect(offers).toBe(1);
  video = container.querySelector('video')!;
  Object.defineProperties(video, {
    videoWidth: { value: 1080 },
    videoHeight: { value: 1920 },
    readyState: { value: 2, configurable: true },
    play: { value: async () => {} },
  });
  await act(async () => {
    metadata.resolve(Response.json(authoritative));
    ControlSocket.instances[0].onopen?.();
    Peer.instances[0].deliverTrack();
  });
  await paintFrame();
  expect(client.status).toBe('streaming');
  // Initial source metadata must not replace the already connecting peer.
  expect(offers).toBe(1);
  expect(Peer.instances).toHaveLength(1);
}

function retainedFrame() {
  return container.querySelector('canvas');
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
  test('retains the last frame from the switch request until replacement video paints', async () => {
    await mount();
    await act(async () => client.setStreamSource('grpc-screenshot'));
    expect(savedFrames).toBe(1);
    expect(retainedFrame()?.style.visibility).toBe('visible');
    await confirmReplacement();
    expect(frameVisibleAtClose).toEqual([true]);
    expect(retainedFrame()?.style.visibility).toBe('visible');
    await act(async () => Peer.instances[1].deliverTrack());
    expect(retainedFrame()?.style.visibility).toBe('visible');
    expect(savedFrames).toBe(1);
    await paintFrame();
    expect(retainedFrame()?.style.visibility).toBe('hidden');
    expect(client.status).toBe('streaming');
  });

  test.each(['device change', 'disabled'] as const)(
    'clears a retained frame on %s',
    async (change) => {
      await mount();
      await act(async () => client.setStreamSource('grpc-screenshot'));
      expect(retainedFrame()?.style.visibility).toBe('visible');
      await act(async () =>
        root.render(
          <Harness
            device={change === 'device change' ? 'emulator-5556' : undefined}
            enabled={change !== 'disabled'}
          />,
        ),
      );
      expect(retainedFrame()?.style.visibility).not.toBe('visible');
    },
  );

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

  test('restarts immediately for a deliberate server close outside a pending switch', async () => {
    await mount();
    await act(async () => ControlSocket.instances[0].onclose?.({ code: 1012 }));
    expect(offers).toBe(2);
    expect(Peer.instances[0].closed).toBe(true);
    expect(retainedFrame()?.style.visibility).toBe('visible');
    expect(client.status).toBe('reconnecting');
  });

  test.each(['before', 'with'] as const)(
    'keeps controls pending if the control socket recovers %s the PUT response',
    async (timing) => {
      await mount();
      await act(async () => client.setStreamSource('grpc-screenshot'));
      expect(retainedFrame()?.style.visibility).toBe('visible');
      await act(async () => ControlSocket.instances[0].onclose?.({ code: 1012 }));
      expect(client.status).toBe('reconnecting');
      await reconnectControl();
      if (timing === 'before') {
        await act(async () => ControlSocket.instances[1].onopen?.());
        expect(client.status).toBe('reconnecting');
        expect(offers).toBe(1);
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
      expect(retainedFrame()?.style.visibility).toBe('hidden');
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
      expect(retainedFrame()?.style.visibility).toBe('visible');
      // Repeated replacements without a new frame must keep the original snapshot.
      expect(savedFrames).toBe(1);
    }
    expect(frameVisibleAtClose).toEqual([true, true]);
    await act(async () => Peer.instances[2].deliverTrack());
    await paintFrame();
    expect(retainedFrame()?.style.visibility).toBe('hidden');
  });
});


test('a delayed old control close cannot replace fresh generation video twice', async () => {
  await mount();
  await act(async () => client.setStreamSource('grpc-screenshot'));
  await confirmReplacement();
  await act(async () => Peer.instances[1].deliverTrack());
  await paintFrame();
  expect(client.streamSourcePending).toBe(false);
  expect(offers).toBe(2);
  const old = ControlSocket.instances[0];
  await act(async () => old.onclose?.({ code: 1012 }));
  expect(offers).toBe(2);
  expect(Peer.instances[1].closed).toBe(false);
  await reconnectControl();
  await act(async () => ControlSocket.instances[1].onopen?.());
  await act(async () => old.onclose?.({ code: 1012 }));
  expect(offers).toBe(2);
  await act(async () => ControlSocket.instances[1].onclose?.({ code: 1012 }));
  expect(offers).toBe(3);
});

test('control reconnect before confirmation recovers if the new video stops', async () => {
  await mount();
  await act(async () => client.setStreamSource('grpc-screenshot'));
  await act(async () => ControlSocket.instances[0].onclose?.({code: 1012}));
  await reconnectControl();
  await act(async () => ControlSocket.instances[1].onopen?.());
  await confirmReplacement();
  await act(async () => Peer.instances[1].deliverTrack());
  await paintFrame();
  expect(client.streamSourcePending).toBe(false);
  expect(offers).toBe(2);
  await act(async () => ControlSocket.instances[1].onclose?.({code: 1012}));
  expect(offers).toBe(2);
  const recovery = [...timeouts].find(([, timer]) => timer.delay === 4_000)!;
  expect(recovery).toBeDefined();
  timeouts.delete(recovery[0]);
  await act(async () => recovery[1].callback());
  expect(offers).toBe(3);
});


test('control reconnected to the old source during staging preserves progressing replacement video', async () => {
  await mount();
  await act(async () => client.setStreamSource('grpc-screenshot'));
  await act(async () => ControlSocket.instances[0].onclose?.({ code: 1006 }));
  const retry = [...timeouts].find(([, timer]) => timer.delay === 500)!;
  expect(retry).toBeDefined();
  timeouts.delete(retry[0]);
  await act(async () => retry[1].callback());
  await act(async () => ControlSocket.instances[1].onopen?.());
  await confirmReplacement();
  await act(async () => Peer.instances[1].deliverTrack());
  await paintFrame();
  await act(async () => ControlSocket.instances[1].onclose?.({ code: 1012 }));
  expect(offers).toBe(2);
  expect([...timeouts.values()].some(timer => timer.delay === 4_000)).toBe(true);
  await paintFrame(); // A buffered loadeddata event cannot prove progress.
  expect([...timeouts.values()].some(timer => timer.delay === 4_000)).toBe(true);
  await act(async () => {
    Object.defineProperty(video, 'paused', { value: false });
    video.currentTime = 1;
    video.dispatchEvent(new window.Event('timeupdate'));
  });
  expect([...timeouts.values()].some(timer => timer.delay === 4_000)).toBe(false);
  expect(offers).toBe(2);
  expect(Peer.instances[1].closed).toBe(false);
});


test('Android input callbacks and held gestures cannot cross a device handoff', async () => {
  await mount();
  const oldClient = client;
  const oldSocket = ControlSocket.instances[0];
  const surface = container.querySelector('[role="application"]') as HTMLDivElement;
  Object.defineProperty(surface, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 100, height: 200 }) });
  Object.assign(surface, { setPointerCapture() {}, releasePointerCapture() {} });
  const frames = new Map<number, FrameRequestCallback>();
  installGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(1, callback); return 1; });
  installGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const pointer = (type: string, x: number) => new window.PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: 20 });
  await act(async () => surface.dispatchEvent(pointer('pointerdown', 10)));
  await act(async () => surface.dispatchEvent(pointer('pointermove', 20)));
  expect(frames.size).toBe(1);
  await act(async () => root.render(<Harness device="emulator-5556" />));
  const replacementSocket = ControlSocket.instances.at(-1)!;
  expect(replacementSocket).not.toBe(oldSocket);
  await act(async () => replacementSocket.onopen?.());
  expect(frames.size).toBe(0);
  await act(async () => {
    oldClient.sendTouch({ phase: 'move', x: .5, y: .5 });
    oldClient.sendKey({ phase: 'down', code: 'KeyA', key: 'a', repeat: false });
    surface.dispatchEvent(pointer('pointermove', 30));
    surface.dispatchEvent(pointer('pointerup', 30));
  });
  expect(replacementSocket.sent.map(message => JSON.parse(message)).filter(message => message.type !== 'reset-video')).toEqual([]);
  await act(async () => surface.dispatchEvent(pointer('pointerdown', 40)));
  expect(replacementSocket.sent.map(message => JSON.parse(message)).some(message => message.type === 'touch')).toBe(true);
});
