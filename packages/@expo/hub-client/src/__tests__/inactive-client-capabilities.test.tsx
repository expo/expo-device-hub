import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useAndroidDeviceClient } from '../useAndroidDevice';
import { useIosDeviceClient } from '../useIosDevice';
import { type DeviceClient, type DeviceConnectionOptions } from '../types';

const originals = new Map<string, PropertyDescriptor | undefined>();
function stubGlobal(name: string, value: unknown) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

class Socket {
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
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

const clients = {
  android: useAndroidDeviceClient,
  ios: useIosDeviceClient,
} satisfies Record<string, (options: DeviceConnectionOptions) => DeviceClient>;

for (const [platform, useClient] of Object.entries(clients)) {
  test(`${platform} client reports no permissions capability while disabled`, async () => {
    stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    stubGlobal('window', { addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout });
    stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
    stubGlobal('WebSocket', Socket);
    stubGlobal('fetch', async (url: string) => {
      if (new URL(url).pathname === '/api') {
        return Response.json({ url: 'https://hub.test/helper/device-1', device: 'device-1' });
      }
      return Response.json({}, { status: 404 });
    });

    let client!: DeviceClient;
    function Harness({ enabled }: { enabled: boolean }) {
      client = useClient({ baseUrl: 'https://hub.test', device: 'device-1', enabled, streamMode: 'mjpeg' });
      return null;
    }
    await act(async () => {
      renderer = create(<Harness enabled={false} />);
    });
    expect(client.capabilities.permissions).toBe(false);
    expect(client.capabilities.accessibility).toBe(false);

    await act(async () => renderer!.update(<Harness enabled />));
    expect(client.capabilities.permissions).toBe(true);

    await act(async () => renderer!.update(<Harness enabled={false} />));
    expect(client.capabilities.permissions).toBe(false);
  });
}
