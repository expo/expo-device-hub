import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useIosDeviceClient } from '../useIosDevice';
import { type DeviceClient } from '../types';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

for (const { name, baseUrl, pageUrl, publicBase } of [
  {
    name: 'remote server on another origin',
    baseUrl: 'https://stream.example.test/preview/session',
    pageUrl: 'https://example.com/device',
    publicBase: 'https://stream.example.test/preview/session',
  },
  {
    name: 'relative middleware mount',
    baseUrl: '/preview/session',
    pageUrl: 'https://example.com/device',
    publicBase: 'https://example.com/preview/session',
  },
]) test(`iOS hook resolves all browser URLs from the ${name}`, async () => {
  const sockets: Array<{
    url: string;
    sent: Array<Record<string, unknown>>;
    onmessage?: (event: { data: string }) => void;
  }> = [];
  const fetchUrls: string[] = [];
  const eventSourceUrls: string[] = [];
  const page = new URL(pageUrl);
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', {
    location: {
      href: page.href,
      origin: page.origin,
      protocol: page.protocol,
      host: page.host,
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal('WebSocket', class {
    readonly OPEN = 1;
    readonly readyState = 1;
    readonly sent: Array<Record<string, unknown>> = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor(readonly url: string) {
      sockets.push(this);
      queueMicrotask(() => {
        this.onopen?.();
        if (url.endsWith('/exec-ws')) this.onmessage?.({ data: '{"ready":true}' });
      });
    }
    send(data: string | ArrayBuffer) {
      if (typeof data !== 'string') return;
      const message = JSON.parse(data) as Record<string, unknown>;
      this.sent.push(message);
      if (message.id === 1) {
        queueMicrotask(() => this.onmessage?.({ data: '{"id":1,"status":{}}' }));
      }
    }
    close() {}
  });
  stubGlobal('EventSource', class {
    constructor(url: string) { eventSourceUrls.push(url); }
    close() {}
  });
  stubGlobal('fetch', async (url: string) => {
    fetchUrls.push(url);
    if (url === `${baseUrl}/api?device=DEVICE-A`) {
      return Response.json({
        device: 'DEVICE-A',
        basePath: '/internal',
        proxyHelpers: true,
        execToken: 'existing-exec-token',
        logsEndpoint: '/internal/logs?device=DEVICE-A',
        eventLogEventsEndpoint: '/internal/api/event-log/events?device=DEVICE-A',
        metricsEndpoint: '/internal/metrics?device=DEVICE-A',
        appStateEndpoint: '/internal/appstate?device=DEVICE-A',
        axEndpoint: '/internal/ax?device=DEVICE-A',
        gridApiEndpoint: '/internal/grid/api',
        url: 'https://stream.example.test:0/internal/helper/DEVICE-A',
        streamUrl: 'https://stream.example.test:0/internal/helper/DEVICE-A/stream.mjpeg',
        wsUrl: 'wss://stream.example.test:0/internal/helper/DEVICE-A/ws',
      });
    }
    return Response.json({ devices: [] });
  });

  let client!: DeviceClient;
  function Harness() {
    client = useIosDeviceClient({ baseUrl, device: 'DEVICE-A', streamMode: 'mjpeg' });
    return null;
  }
  await act(async () => { renderer = create(<Harness />); });

  const image = {
    src: '',
    naturalWidth: 0,
    naturalHeight: 0,
    addEventListener() {},
    removeEventListener() {},
    removeAttribute() {},
  };
  await act(async () => client.attachVideo(image as unknown as HTMLImageElement));
  await act(async () => {
    client.attachLogs();
    client.attachEvents();
    client.refreshAccessibility();
  });

  expect(fetchUrls).toContain(`${baseUrl}/api?device=DEVICE-A`);
  expect(fetchUrls).toContain(`${publicBase}/grid/api`);
  expect(fetchUrls).toContain(`${publicBase}/ax?device=DEVICE-A`);
  expect(eventSourceUrls).toContain(`${publicBase}/appstate?device=DEVICE-A`);
  expect(new URL(image.src).origin + new URL(image.src).pathname).toBe(
    `${publicBase}/helper/DEVICE-A/stream.mjpeg`,
  );
  expect(sockets.map((socket) => socket.url)).toContain(
    `${publicBase.replace(/^http/, 'ws')}/helper/ws?device=DEVICE-A`,
  );
  expect(sockets.map((socket) => socket.url)).toContain(
    `${publicBase.replace(/^http/, 'ws')}/exec-ws`,
  );
  const subscriptions = sockets.flatMap((socket) => socket.sent).filter((message) => 'sub' in message);
  expect(subscriptions).toContainEqual({ sub: 1, path: '/internal/logs?device=DEVICE-A' });
  expect(subscriptions).toContainEqual({ sub: 2, path: '/internal/api/event-log/events?device=DEVICE-A' });
  expect(subscriptions).toContainEqual({ sub: 3, path: '/internal/metrics?device=DEVICE-A' });
});
