import { afterEach, describe, expect, test } from 'bun:test';
import { useLayoutEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { type DeviceClient, type DeviceConnectionOptions } from '../types';
import { useAndroidDeviceClient } from '../useAndroidDevice';
import { useIosDeviceClient } from '../useIosDevice';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

type Network = {
  fetches: Array<{ url: string; authorization: string | null }>;
  sockets: Array<{ url: string; protocols: string[] | undefined }>;
  eventSources: string[];
  imageSources: string[];
};

/** Records every request the client makes, the way a browser would issue it. */
function stubNetwork(respond: (url: URL) => unknown, pageOrigin = 'https://sim.test'): Network {
  const network: Network = { fetches: [], sockets: [], eventSources: [], imageSources: [] };
  const page = new URL(pageOrigin);
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', {
    location: { protocol: page.protocol, host: page.host, origin: page.origin, href: page.href },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    network.fetches.push({ url: input, authorization: new Headers(init?.headers).get('authorization') });
    const body = respond(new URL(input));
    return body === undefined ? Response.json({}, { status: 404 }) : Response.json(body);
  });
  stubGlobal(
    'WebSocket',
    class {
      binaryType = 'blob';
      readyState = 0;
      onopen = null;
      onmessage = null;
      onerror = null;
      onclose = null;
      constructor(url: string, protocols?: string[]) {
        network.sockets.push({ url, protocols });
      }
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {}
    }
  );
  stubGlobal(
    'EventSource',
    class {
      onmessage = null;
      onerror = null;
      constructor(url: string) {
        network.eventSources.push(url);
      }
      addEventListener() {}
      close() {}
    }
  );
  return network;
}

const image = (network: Network) =>
  ({
    set src(value: string) {
      network.imageSources.push(value);
    },
    naturalWidth: 0,
    naturalHeight: 0,
    addEventListener() {},
    removeEventListener() {},
    removeAttribute() {},
  }) as unknown as HTMLImageElement;

async function render(
  useClient: (options: DeviceConnectionOptions) => DeviceClient,
  options: DeviceConnectionOptions,
  network: Network
): Promise<DeviceClient> {
  let client!: DeviceClient;
  const img = image(network);
  function Harness() {
    client = useClient(options);
    const { attachVideo } = client;
    useLayoutEffect(() => attachVideo(img), [attachVideo]);
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  // Let the config resolve and the connections it starts open.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return client;
}

// A serve-sim behind a public mount, the way an EAS Simulator Preview session serves it.
const IOS_BASE = 'https://sim.test/preview/session';
const iosApiAt = (base: string) => (url: URL) =>
  url.origin === new URL(base).origin && url.pathname === '/preview/session/api'
    ? {
        url: `${base}/helper/UDID-1`,
        device: 'UDID-1',
        basePath: '/preview/session',
        proxyHelpers: true,
        execToken: 'tok-1',
        appStateEndpoint: '/preview/session/appstate?device=UDID-1',
        gridApiEndpoint: '/preview/session/grid/api',
        streamSettingsEndpoint: '/preview/session/helper/UDID-1/stream-settings',
      }
    : undefined;
const iosApi = iosApiAt(IOS_BASE);

describe('useIosDeviceClient with a session token', () => {
  test('presents the token on every request, socket, and stream it opens', async () => {
    const network = stubNetwork(iosApi);

    await render(
      useIosDeviceClient,
      { baseUrl: IOS_BASE, device: 'UDID-1', streamMode: 'mjpeg', token: 'tok-1' },
      network
    );

    expect(network.fetches.length).toBeGreaterThan(1);
    expect(network.fetches.filter((call) => call.authorization !== 'Bearer tok-1')).toEqual([]);
    expect(network.sockets.length).toBeGreaterThan(1);
    expect(network.sockets.filter((socket) => socket.protocols?.[0] !== 'serve-sim.token.tok-1')).toEqual([]);
    expect(network.sockets.every((socket) => !socket.url.includes('token='))).toBe(true);
    expect(network.eventSources).toEqual([`${IOS_BASE}/appstate?device=UDID-1&token=tok-1`]);
    expect(network.imageSources.length).toBeGreaterThan(0);
    expect(network.imageSources.every((src) => src.includes('token=tok-1'))).toBe(true);
  });

  test('presents the token on the app icon request', async () => {
    const network = stubNetwork((url) =>
      url.pathname === '/preview/session/api/apps/icon'
        ? { ok: true, bundleId: 'com.example.foo', icon: { mimeType: 'image/png', data: 'aWNvbg==' } }
        : (() => {
            const api = iosApi(url);
            return api && { ...api, appIconEndpoint: '/preview/session/api/apps/icon?device=UDID-1' };
          })()
    );
    const appState: Array<{ onmessage: ((event: { data: string }) => void) | null }> = [];
    stubGlobal(
      'EventSource',
      class {
        onmessage = null;
        onerror = null;
        constructor(url: string) {
          network.eventSources.push(url);
          appState.push(this);
        }
        addEventListener() {}
        close() {}
      }
    );

    await render(
      useIosDeviceClient,
      { baseUrl: IOS_BASE, device: 'UDID-1', streamMode: 'mjpeg', token: 'tok-1' },
      network
    );
    await act(async () => {
      for (const source of appState) source.onmessage?.({ data: JSON.stringify({ bundleId: 'com.example.foo' }) });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(network.fetches.filter((call) => call.url.includes('/api/apps/icon'))).toEqual([
      {
        url: `${IOS_BASE}/api/apps/icon?device=UDID-1&bundleId=com.example.foo`,
        authorization: 'Bearer tok-1',
      },
    ]);
  });

  // serve-sim proxies the helper, so its URLs belong on serve-sim, not on the page that embeds the client.
  test('streams from serve-sim when the page is on another origin', async () => {
    const network = stubNetwork(iosApi, 'https://app.test');

    await render(
      useIosDeviceClient,
      { baseUrl: IOS_BASE, device: 'UDID-1', streamMode: 'mjpeg', token: 'tok-1' },
      network
    );

    expect(network.imageSources.length).toBeGreaterThan(0);
    for (const src of network.imageSources) {
      expect(src.startsWith(`${IOS_BASE}/helper/UDID-1/stream.mjpeg?`)).toBe(true);
    }
    expect(network.sockets.map((socket) => new URL(socket.url).host)).not.toContain('app.test');
  });

  // serve-sim's own preview page carries its cookie, so nothing changes without a token.
  test('adds no credential without one', async () => {
    const network = stubNetwork(iosApi);

    await render(useIosDeviceClient, { baseUrl: IOS_BASE, device: 'UDID-1', streamMode: 'mjpeg' }, network);

    expect(network.fetches.every((call) => call.authorization === null)).toBe(true);
    expect(network.sockets.every((socket) => socket.protocols === undefined)).toBe(true);
    expect([...network.eventSources, ...network.imageSources].some((url) => url.includes('token='))).toBe(false);
  });

  // The old config stays in state until the new `/api` answers. Its URLs must not get the new token.
  test('sends a new token only to the server it belongs to', async () => {
    const SERVER_A = 'https://a.test/preview/session';
    const SERVER_B = 'https://b.test/preview/session';
    // Server B never resolves, so the client keeps polling its `/api`.
    const network = stubNetwork(iosApiAt(SERVER_A));
    let options: DeviceConnectionOptions = {
      baseUrl: SERVER_A,
      device: 'UDID-1',
      streamMode: 'mjpeg',
      token: 'tok-a',
    };
    const img = image(network);
    function Harness() {
      const { attachVideo } = useIosDeviceClient(options);
      useLayoutEffect(() => attachVideo(img), [attachVideo]);
      return null;
    }
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(network.sockets.length).toBeGreaterThan(0);

    network.fetches.length = 0;
    network.sockets.length = 0;
    network.eventSources.length = 0;
    network.imageSources.length = 0;
    options = { ...options, baseUrl: SERVER_B, token: 'tok-b' };
    await act(async () => renderer?.update(<Harness />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

    const toServerA = [
      ...network.fetches.map((call) => call.url),
      ...network.sockets.map((socket) => socket.url),
      ...network.eventSources,
      ...network.imageSources,
    ].filter((url) => new URL(url).host === 'a.test');
    expect(toServerA).toEqual([]);
    expect(network.fetches).toContainEqual({ url: `${SERVER_B}/api?device=UDID-1`, authorization: 'Bearer tok-b' });
  });
});

const ANDROID_BASE = 'https://hub.test/vendor/serve-emu';
const androidApi = (url: URL) =>
  url.pathname === '/vendor/serve-emu/api' ? { size: { width: 1080, height: 2400 } } : {};

/** The H.264 socket opens only where the browser can decode it. */
function stubWebCodecs() {
  stubGlobal('VideoDecoder', class {});
  stubGlobal('EncodedVideoChunk', class {});
}

describe('useAndroidDeviceClient with a session token', () => {
  test('presents the token on every request, socket, and event stream it opens', async () => {
    const network = stubNetwork(androidApi);
    stubWebCodecs();

    const client = await render(
      useAndroidDeviceClient,
      { baseUrl: ANDROID_BASE, device: 'emulator-5554', streamMode: 'h264', token: 'tok-1' },
      network
    );
    await act(async () => client.attachLogs());

    expect(network.fetches.length).toBeGreaterThan(1);
    expect(network.fetches.filter((call) => call.authorization !== 'Bearer tok-1')).toEqual([]);
    expect(network.sockets.length).toBeGreaterThan(0);
    expect(network.sockets.filter((socket) => socket.protocols?.[0] !== 'serve-emu.token.tok-1')).toEqual([]);
    expect(network.sockets.every((socket) => !socket.url.includes('token='))).toBe(true);
    expect(network.eventSources.length).toBe(2);
    expect(network.eventSources.every((url) => url.includes('token=tok-1'))).toBe(true);
  });

  test('adds no credential without one', async () => {
    const network = stubNetwork(androidApi);
    stubWebCodecs();

    const client = await render(
      useAndroidDeviceClient,
      { baseUrl: ANDROID_BASE, device: 'emulator-5554', streamMode: 'h264' },
      network
    );
    await act(async () => client.attachLogs());

    expect(network.fetches.every((call) => call.authorization === null)).toBe(true);
    expect(network.sockets.every((socket) => socket.protocols === undefined)).toBe(true);
    expect(network.eventSources.some((url) => url.includes('token='))).toBe(false);
  });
});
