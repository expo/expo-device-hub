import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useAndroidDeviceClient } from '../useAndroidDevice';
import { useIosDeviceClient } from '../useIosDevice';
import { type DeviceClient, type DeviceConnectionOptions } from '../types';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();

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
  restoreGlobals();
});

// serve-sim serves no permissions route, so iOS reports the capability off either way.
const clients = {
  android: { useClient: useAndroidDeviceClient, whenEnabled: true },
  ios: { useClient: useIosDeviceClient, whenEnabled: false },
} satisfies Record<
  string,
  { useClient: (options: DeviceConnectionOptions) => DeviceClient; whenEnabled: boolean }
>;

for (const [platform, { useClient, whenEnabled }] of Object.entries(clients)) {
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
    expect(client.capabilities.permissions).toBe(whenEnabled);

    await act(async () => renderer!.update(<Harness enabled={false} />));
    expect(client.capabilities.permissions).toBe(false);
  });
}

test('Android recording metadata follows host transitions and does not leak between selected devices', async () => {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', { addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal('WebSocket', Socket);
  const pollers: (() => void)[] = [];
  stubGlobal('setInterval', (callback: () => void, ms: number) => {
    if (ms === 1500) pollers.push(callback);
    return 0;
  });
  stubGlobal('clearInterval', () => {});
  let recording = 'recording';
  stubGlobal('fetch', async (url: string) => {
    const request = new URL(url);
    return request.pathname === '/api'
      ? Response.json({ screenRecording: request.searchParams.get('device') === 'device-1' ? { status: recording } : null })
      : Response.json({}, { status: 404 });
  });
  let client: DeviceClient | undefined;
  function Harness({ device }: { device: string }) {
    client = useAndroidDeviceClient({ baseUrl: 'https://hub.test', device, enabled: true, streamMode: 'h264' });
    return null;
  }
  await act(async () => { renderer = create(<Harness device="device-1" />); });
  expect(client?.screenRecording).toBe('recording');
  recording = 'complete';
  await act(async () => { for (const poll of pollers) poll(); });
  expect(client?.screenRecording).toBe('complete');
  await act(async () => { renderer?.update(<Harness device="device-2" />); });
  expect(client?.screenRecording).toBeNull();
});

test('recording stays unknown until metadata loads and resets on device changes and reactivation', async () => {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', { addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal('WebSocket', Socket);
  const pollers: (() => void)[] = [];
  stubGlobal('setInterval', (callback: () => void, ms: number) => {
    if (ms === 1500) pollers.push(callback);
    return 0;
  });
  stubGlobal('clearInterval', () => {});
  const requests: ((response: Response) => void)[] = [];
  stubGlobal('fetch', (url: string) => new URL(url).pathname === '/api'
    ? new Promise<Response>((resolve) => requests.push(resolve))
    : Promise.resolve(Response.json({}, { status: 404 })));
  let client: DeviceClient | undefined;
  function Harness({ device = 'device-1', enabled = true }: { device?: string; enabled?: boolean }) {
    client = useAndroidDeviceClient({ baseUrl: 'https://hub.test', device, enabled, streamMode: 'h264' });
    return null;
  }
  async function respond(response: Response) {
    const resolve = requests.shift();
    if (!resolve) throw new Error('Expected a pending recording metadata request');
    await act(async () => resolve(response));
  }
  await act(async () => { renderer = create(<Harness />); });
  expect(client?.screenRecording).toBe('unknown');
  await respond(Response.json({}, { status: 503 }));
  expect(client?.screenRecording).toBe('unknown');
  await act(async () => { for (const poll of pollers) poll(); });
  await respond(Response.json({ screenRecording: null }));
  expect(client?.screenRecording).toBeNull();

  // A request for the previous device must not unlock the newly selected device.
  await act(async () => { for (const poll of pollers) poll(); });
  await act(async () => renderer?.update(<Harness device="device-2" />));
  expect(client?.screenRecording).toBe('unknown');
  await respond(Response.json({ screenRecording: null }));
  expect(client?.screenRecording).toBe('unknown');
  await respond(Response.json({ screenRecording: { status: 'complete' } }));
  expect(client?.screenRecording).toBe('complete');

  await act(async () => renderer?.update(<Harness device="device-2" enabled={false} />));
  expect(client?.screenRecording).toBeNull();
  await act(async () => renderer?.update(<Harness device="device-2" />));
  expect(client?.screenRecording).toBe('unknown');
  await respond(Response.json({ screenRecording: { status: 'recording' } }));
  expect(client?.screenRecording).toBe('recording');
});
