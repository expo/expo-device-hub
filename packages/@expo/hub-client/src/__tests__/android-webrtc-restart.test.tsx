import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useAndroidDeviceClient } from '../useAndroidDevice';
import { DeviceScreen } from '../DeviceScreen';
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
  expect(oldSocket.sent.map(message => JSON.parse(message))
    .filter(message => message.type === 'touch').map(message => message.action)).toEqual(['down', 'up']);
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

test('retired Android input callbacks stay retired when returning to the same device', async () => {
  await mount();
  const firstClient = client;
  await act(async () => root.render(<Harness device="emulator-5556" />));
  await act(async () => ControlSocket.instances.at(-1)!.onopen?.());
  await act(async () => root.render(<Harness device="emulator-5554" />));
  const returnedSocket = ControlSocket.instances.at(-1)!;
  await act(async () => returnedSocket.onopen?.());
  const inputMessages = () => returnedSocket.sent.map(message => JSON.parse(message))
    .filter(message => message.type !== 'reset-video');
  await act(async () => {
    firstClient.sendTouch({ phase: 'begin', x: 0.5, y: 0.5 });
    expect(firstClient.sendKey({ phase: 'down', code: 'KeyA', key: 'a', repeat: false })).toBe(false);
  });
  expect(inputMessages()).toEqual([]);
  await act(async () => client.sendTouch({ phase: 'begin', x: 0.2, y: 0.3 }));
  expect(inputMessages()).toHaveLength(1);
});
