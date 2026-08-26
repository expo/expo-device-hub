import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { createElement, StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { type DeviceClient, type DeviceHttpCodec } from '../types';
import { useIosDeviceClient } from '../useIosDevice';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = '';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this.sent.push(String(data));
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const windowListeners = new Map<string, Set<() => void>>();
const documentListeners = new Map<string, Set<() => void>>();
let renderer: ReactTestRenderer | null = null;
let latestClient: DeviceClient | null = null;
let fetchCalls: Array<{ url: string; method: string }> = [];
let pendingStreamSettingsPatch:
  | { promise: Promise<Response>; resolve: (response: Response) => void }
  | undefined;

function emit(listeners: Map<string, Set<() => void>>, event: string) {
  for (const listener of listeners.get(event) ?? []) listener();
}

function installBrowserBoundaries() {
  const add = (listeners: Map<string, Set<() => void>>, event: string, listener: () => void) => {
    const current = listeners.get(event) ?? new Set();
    current.add(listener);
    listeners.set(event, current);
  };
  const remove = (listeners: Map<string, Set<() => void>>, event: string, listener: () => void) => {
    listeners.get(event)?.delete(listener);
  };
  (globalThis as any).window = {
    location: new URL('http://hub.test/'),
    addEventListener: (event: string, listener: () => void) =>
      add(windowListeners, event, listener),
    removeEventListener: (event: string, listener: () => void) =>
      remove(windowListeners, event, listener),
    setTimeout,
    clearTimeout,
  };
  (globalThis as any).document = {
    visibilityState: 'visible',
    addEventListener: (event: string, listener: () => void) =>
      add(documentListeners, event, listener),
    removeEventListener: (event: string, listener: () => void) =>
      remove(documentListeners, event, listener),
  };
  (globalThis as any).WebSocket = FakeWebSocket;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetch() {
  (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    fetchCalls.push({ url, method });
    if (url === 'http://hub.test/api?device=sim-1') {
      return jsonResponse({
        url: 'http://helper.test/helper/sim-1',
        streamUrl: 'http://helper.test/helper/sim-1/stream.mjpeg',
        wsUrl: 'ws://helper.test/helper/sim-1/ws',
        device: 'sim-1',
        execToken: 'test-token',
        logsEndpoint: '/logs?device=sim-1',
        eventLogEventsEndpoint: '/events?device=sim-1',
        metricsEndpoint: '/metrics?device=sim-1',
        streamSettingsEndpoint: '/stream-settings?device=sim-1',
      });
    }
    if (url === 'http://hub.test/stream-settings?device=sim-1' && method === 'PATCH') {
      if (pendingStreamSettingsPatch) return pendingStreamSettingsPatch.promise;
      return jsonResponse({
        mjpegFps: 30,
        mjpegQuality: 0.7,
        maxDimension: 0,
        h264Bitrate: 6_000_000,
        h264Fps: 60,
      });
    }
    if (url === 'http://hub.test/stream-settings?device=sim-1') {
      return jsonResponse({
        mjpegFps: 60,
        mjpegQuality: 0.7,
        maxDimension: 0,
        h264Bitrate: 6_000_000,
        h264Fps: 60,
      });
    }
    if (url === 'http://hub.test/grid/api') return jsonResponse({ devices: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

function Harness({
  streamMode = 'mjpeg',
  httpCodec,
}: {
  streamMode?: 'mjpeg' | 'h264' | 'webrtc';
  httpCodec?: DeviceHttpCodec;
}) {
  latestClient = useIosDeviceClient({
    baseUrl: 'http://hub.test',
    device: 'sim-1',
    streamMode,
    httpCodec,
  });
  return null;
}

async function mountClient(
  streamMode: 'mjpeg' | 'h264' | 'webrtc' = 'mjpeg',
  httpCodec?: DeviceHttpCodec,
) {
  await act(async () => {
    renderer = create(createElement(Harness, { streamMode, httpCodec }));
    await Promise.resolve();
    await Promise.resolve();
  });
  return () => latestClient!;
}

async function mountStrictClient() {
  const strictOptions = { createNodeMock: () => null, unstable_strictMode: true };
  await act(async () => {
    renderer = create(createElement(StrictMode, null, createElement(Harness)), strictOptions);
    await Promise.resolve();
    await Promise.resolve();
  });
  return () => latestClient!;
}

function execSockets() {
  return FakeWebSocket.instances.filter((socket) => new URL(socket.url).pathname === '/exec-ws');
}

function sentMessages(socket: FakeWebSocket) {
  return socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
}

function readyExecConnections() {
  for (const socket of execSockets()) {
    socket.open();
    socket.receive({ ready: true });
  }
  const pool = execSockets().find((socket) =>
    sentMessages(socket).some((message) => message.path === '/metrics?device=sim-1'),
  )!;
  const ui = execSockets().find((socket) =>
    sentMessages(socket).some((message) => typeof message.ui === 'object'),
  )!;
  ui.receive({ id: 1, status: { appearance: 'light' } });
  return pool;
}

beforeEach(() => {
  jest.useFakeTimers();
  FakeWebSocket.instances = [];
  windowListeners.clear();
  documentListeners.clear();
  latestClient = null;
  fetchCalls = [];
  pendingStreamSettingsPatch = undefined;
  installBrowserBoundaries();
  installFetch();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  jest.clearAllTimers();
  jest.useRealTimers();
  delete (globalThis as any).fetch;
  delete (globalThis as any).WebSocket;
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).VideoDecoder;
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

describe('iOS client serve-sim parity', () => {
  test('reports a stalled device-settings hydration after 15 seconds and can retry it', async () => {
    const client = await mountClient();
    const initialRequest = execSockets().at(-1)!;
    initialRequest.open();
    initialRequest.receive({ ready: true });

    expect(client().deviceSettingsError).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(14_999);
    });
    expect(client().deviceSettingsError).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(client().deviceSettingsError).toBe('Device options did not respond.');

    await act(async () => client().retryDeviceSettings());
    const retry = execSockets().at(-1)!;
    expect(retry).not.toBe(initialRequest);
    retry.open();
    retry.receive({ ready: true });
    retry.receive({ id: 1, status: { appearance: 'dark', 'reduce-motion': 'on' } });
    await act(async () => Promise.resolve());

    expect(client().deviceSettingsError).toBeNull();
    expect(client().deviceSettings).toEqual({ appearance: 'dark', 'reduce-motion': 'on' });
  });

  test('adds, removes, and retries one event stream without interrupting metrics', async () => {
    const client = await mountClient();
    const pool = readyExecConnections();
    expect(pool.readyState).toBe(FakeWebSocket.OPEN);

    await act(async () => client().attachLogs());

    expect(pool.readyState).toBe(FakeWebSocket.OPEN);
    const logSubscription = sentMessages(pool).find(
      (message) => message.path === '/logs?device=sim-1',
    );
    expect(logSubscription).toBeDefined();

    pool.receive({ sub: logSubscription!.sub, end: true });
    expect(pool.readyState).toBe(FakeWebSocket.OPEN);
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    expect(
      sentMessages(pool).filter((message) => message.path === '/logs?device=sim-1'),
    ).toHaveLength(2);

    await act(async () => client().detachLogs());
    expect(pool.readyState).toBe(FakeWebSocket.OPEN);
    expect(sentMessages(pool)).toContainEqual({ unsub: expect.any(Number) });
    expect(
      sentMessages(pool).filter((message) => message.path === '/metrics?device=sim-1'),
    ).toHaveLength(1);
  });

  test('reconnects the shared event socket after Strict Mode effect replay', async () => {
    await mountStrictClient();

    for (const socket of execSockets().filter(
      (candidate) => candidate.readyState === FakeWebSocket.CONNECTING,
    )) {
      socket.open();
      socket.receive({ ready: true });
    }

    const activeMetricsSocket = execSockets().find(
      (socket) =>
        socket.readyState === FakeWebSocket.OPEN &&
        sentMessages(socket).some((message) => message.path === '/metrics?device=sim-1'),
    );
    expect(activeMetricsSocket).toBeDefined();
  });

  test('revalidates shared stream settings every three seconds and when the page becomes active', async () => {
    await mountClient();
    const streamSettingsGets = () =>
      fetchCalls.filter(
        (call) =>
          call.url === 'http://hub.test/stream-settings?device=sim-1' && call.method === 'GET',
      );

    expect(streamSettingsGets()).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(2_999);
    });
    expect(streamSettingsGets()).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(streamSettingsGets()).toHaveLength(2);

    await act(async () => emit(windowListeners, 'focus'));
    expect(streamSettingsGets()).toHaveLength(3);

    (document as any).visibilityState = 'hidden';
    await act(async () => {
      jest.advanceTimersByTime(3_000);
    });
    expect(streamSettingsGets()).toHaveLength(3);
    (document as any).visibilityState = 'visible';
    await act(async () => emit(documentListeners, 'visibilitychange'));
    expect(streamSettingsGets()).toHaveLength(4);
  });

  test('does not let a refresh race an in-flight stream-settings patch', async () => {
    const client = await mountClient();
    let resolvePatch!: (response: Response) => void;
    pendingStreamSettingsPatch = {
      promise: new Promise((resolve) => {
        resolvePatch = resolve;
      }),
      resolve: (response) => resolvePatch(response),
    };
    const streamSettingsGets = () =>
      fetchCalls.filter(
        (call) =>
          call.url === 'http://hub.test/stream-settings?device=sim-1' && call.method === 'GET',
      );

    expect(streamSettingsGets()).toHaveLength(1);
    await act(async () => client().updateStreamSettings({ mjpegFps: 30 }));
    expect(client().streamSettingsPending).toBeTrue();
    await act(async () => {
      emit(windowListeners, 'focus');
      jest.advanceTimersByTime(3_000);
    });
    expect(streamSettingsGets()).toHaveLength(1);

    pendingStreamSettingsPatch.resolve(
      jsonResponse({
        mjpegFps: 30,
        mjpegQuality: 0.7,
        maxDimension: 0,
        h264Bitrate: 6_000_000,
        h264Fps: 60,
      }),
    );
    await act(async () => Promise.resolve());
    expect(client().streamSettingsPending).toBeFalse();
    await act(async () => emit(windowListeners, 'focus'));
    expect(streamSettingsGets()).toHaveLength(2);
  });

  test('retains remembered MJPEG when WebRTC falls back to HTTP', async () => {
    const client = await mountClient('webrtc', 'mjpeg');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client().videoKind).toBe('img');
    expect(client().activeStreamMode).toBe('mjpeg');
  });

  for (const httpCodec of ['auto', 'h264'] as const) {
    test(`uses H.264 when WebRTC falls back with remembered ${httpCodec}`, async () => {
      (globalThis as any).VideoDecoder = class {};
      const client = await mountClient('webrtc', httpCodec);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(client().videoKind).toBe('canvas');
      expect(client().activeStreamMode).toBe('h264');
    });
  }
});
