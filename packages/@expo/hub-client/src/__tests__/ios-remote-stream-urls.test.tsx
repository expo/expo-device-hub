import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useIosDeviceClient } from '../useIosDevice';
import { type DeviceClient } from '../types';

const originals = new Map<string, PropertyDescriptor | undefined>();
function stubGlobal(name: string, value: unknown) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
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

test('iOS hook streams from the configured remote server, not the embedding page', async () => {
  const socketUrls: string[] = [];
  const fetchUrls: string[] = [];
  const baseUrl = 'https://stream.example.test/preview/session';
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', {
    location: {
      href: 'https://example.com/device',
      origin: 'https://example.com',
      protocol: 'https:',
      host: 'example.com',
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal('WebSocket', class {
    constructor(url: string) { socketUrls.push(url); }
    close() {}
  });
  stubGlobal('fetch', async (url: string) => {
    fetchUrls.push(url);
    if (url === `${baseUrl}/api?device=DEVICE-A`) {
      return Response.json({
        device: 'DEVICE-A',
        basePath: '/internal',
        proxyHelpers: true,
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

  expect(fetchUrls).toContain(`${baseUrl}/api?device=DEVICE-A`);
  expect(new URL(image.src).origin + new URL(image.src).pathname).toBe(
    `${baseUrl}/helper/DEVICE-A/stream.mjpeg`,
  );
  expect(socketUrls).toContain('wss://stream.example.test/preview/session/helper/ws?device=DEVICE-A');
});
