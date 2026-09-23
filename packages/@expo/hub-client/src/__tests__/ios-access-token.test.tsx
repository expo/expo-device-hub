import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { type DeviceClient } from '../types';
import { useIosDeviceClient } from '../useIosDevice';

// Hook lifecycle under react-test-renderer, like the other hook tests here. What
// this checks is the wire shape a `--require-token` serve-sim needs on every
// channel the iOS client opens, not decoding or rendering.

const originals = new Map<string, PropertyDescriptor | undefined>();
function stubGlobal(name: string, value: unknown) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

class Socket {
  static opened: Array<{ url: string; protocols?: string[] }> = [];
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string, protocols?: string[]) {
    Socket.opened.push({ url, protocols });
  }
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}

class Source {
  static opened: string[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(url: string) {
    Source.opened.push(url);
  }
  close() {}
}

const TOKEN = 'session-token';
const BASE = 'https://hub.test/vendor/serve-sim';

function stubBrowser() {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', {
    location: { origin: 'https://hub.test', host: 'hub.test', protocol: 'https:', href: 'https://hub.test/' },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  Socket.opened = [];
  Source.opened = [];
  stubGlobal('WebSocket', Socket);
  stubGlobal('EventSource', Source);
}

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

function renderClient(accessToken: string | null): () => DeviceClient {
  let client!: DeviceClient;
  function Harness() {
    client = useIosDeviceClient({
      baseUrl: BASE,
      device: 'device-1',
      enabled: true,
      streamMode: 'mjpeg',
      accessToken,
    });
    return null;
  }
  return () => {
    if (!renderer) renderer = create(<Harness />);
    return client;
  };
}

test('presents the token on every serve-sim channel', async () => {
  stubBrowser();
  const requests: Array<{ path: string; authorization: string | null }> = [];
  stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url);
    requests.push({ path: pathname, authorization: new Headers(init?.headers).get('authorization') });
    if (pathname.endsWith('/api')) {
      // What a gated middleware answers once the bearer is right. No `execToken`
      // here so the client has to fall back to the access token for exec-ws.
      return Response.json({
        url: 'https://hub.test/vendor/serve-sim/helper/device-1',
        streamUrl: 'https://hub.test/vendor/serve-sim/helper/device-1/stream.mjpeg',
        wsUrl: 'wss://hub.test/vendor/serve-sim/helper/device-1/ws',
        device: 'device-1',
        basePath: '/vendor/serve-sim',
        appStateEndpoint: '/vendor/serve-sim/appstate?device=device-1',
        gridApiEndpoint: '/vendor/serve-sim/grid/api',
        proxyHelpers: true,
      });
    }
    return Response.json({ devices: [] });
  });

  const read = renderClient(TOKEN);
  await act(async () => {
    read();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const bearer = `Bearer ${TOKEN}`;
  expect(requests.find((r) => r.path === '/vendor/serve-sim/api')?.authorization).toBe(bearer);
  expect(requests.find((r) => r.path === '/vendor/serve-sim/grid/api')?.authorization).toBe(bearer);

  // HID input and the exec channel (opened for the settings read) name the token as a subprotocol.
  const hid = Socket.opened.find((s) => s.url.includes('/helper/ws'));
  const exec = Socket.opened.find((s) => s.url.endsWith('/exec-ws'));
  expect(hid?.protocols).toEqual([`serve-sim.token.${TOKEN}`]);
  expect(exec?.protocols).toEqual([`serve-sim.token.${TOKEN}`]);

  // EventSource cannot set a header, so the query carries it.
  expect(Source.opened).toEqual([
    `https://hub.test/vendor/serve-sim/appstate?device=device-1&token=${TOKEN}`,
  ]);
});

test('reports a 401 from a gated serve-sim instead of looking unreachable', async () => {
  stubBrowser();
  stubGlobal('fetch', async () => new Response('Unauthorized', { status: 401 }));

  const read = renderClient(null);
  await act(async () => {
    read();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const client = read();
  expect(client.status).toBe('error');
  expect(client.error).toContain('--require-token');
  expect(Socket.opened).toEqual([]);
});

test('opens plain sockets and clean URLs without a token', async () => {
  stubBrowser();
  const authorizations: Array<string | null> = [];
  stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get('authorization'));
    if (new URL(url).pathname.endsWith('/api')) {
      return Response.json({
        url: 'https://hub.test/vendor/serve-sim/helper/device-1',
        wsUrl: 'wss://hub.test/vendor/serve-sim/helper/device-1/ws',
        device: 'device-1',
        basePath: '/vendor/serve-sim',
        appStateEndpoint: '/vendor/serve-sim/appstate?device=device-1',
        execToken: 'exec-only',
      });
    }
    return Response.json({ devices: [] });
  });

  const read = renderClient(null);
  await act(async () => {
    read();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(authorizations.every((value) => value === null)).toBe(true);
  expect(Socket.opened.find((s) => s.url.includes('/helper/ws'))?.protocols).toBeUndefined();
  // The exec token from `/api` still names itself on exec-ws; harmless for an ungated server.
  expect(Socket.opened.find((s) => s.url.endsWith('/exec-ws'))?.protocols).toEqual([
    'serve-sim.token.exec-only',
  ]);
  expect(Source.opened).toEqual(['https://hub.test/vendor/serve-sim/appstate?device=device-1']);
});

test('a consumer on another origin still streams from the Hub, not from its own page', async () => {
  stubBrowser();
  // The page lives on app.test; the Hub (and its proxied helpers) on hub.test.
  (globalThis as any).window.location = {
    origin: 'https://app.test',
    host: 'app.test',
    protocol: 'https:',
    href: 'https://app.test/devices',
  };
  const requests: string[] = [];
  stubGlobal('fetch', async (url: string) => {
    requests.push(url.replace(/token=[^&]+/, 'token=<t>'));
    if (new URL(url).pathname.endsWith('/api')) {
      return Response.json({
        url: 'http://127.0.0.1:0/vendor/serve-sim/helper/device-1',
        wsUrl: 'ws://127.0.0.1:0/vendor/serve-sim/helper/device-1/ws',
        device: 'device-1',
        basePath: '/vendor/serve-sim',
        appStateEndpoint: '/vendor/serve-sim/appstate?device=device-1',
        streamSettingsEndpoint: 'http://127.0.0.1:0/stream-settings',
        proxyHelpers: true,
      });
    }
    return Response.json({ devices: [] });
  });

  const read = renderClient(TOKEN);
  await act(async () => {
    read();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const hid = Socket.opened.find((s) => s.url.includes('/helper/ws'));
  expect(hid?.url).toBe('wss://hub.test/vendor/serve-sim/helper/ws?device=device-1');
  expect(hid?.protocols).toEqual([`serve-sim.token.${TOKEN}`]);
  expect(requests).toContain(
    'https://hub.test/vendor/serve-sim/helper/device-1/stream-settings',
  );
  // Nothing, and in particular no token, went to the page's own origin.
  expect(requests.some((url) => url.startsWith('https://app.test'))).toBe(false);
  expect(Socket.opened.some((s) => s.url.includes('app.test'))).toBe(false);
  expect(Source.opened.some((url) => url.includes('app.test'))).toBe(false);
});
