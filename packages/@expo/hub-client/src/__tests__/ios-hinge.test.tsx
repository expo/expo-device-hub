import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { type DeviceClient, type DeviceConnectionOptions } from '../types';
import { useIosDeviceClient } from '../useIosDevice';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();

/** The helper's binary input socket: `[tag][JSON]` both ways. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  binaryType = 'blob';
  readyState = 0;
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: ArrayBuffer) {
    this.sent.push(new Uint8Array(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(tag: number, payload: unknown) {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const bytes = new Uint8Array(1 + json.length);
    bytes[0] = tag;
    bytes.set(json, 1);
    this.onmessage?.({ data: bytes.buffer });
  }
  frames() {
    return this.sent.map((bytes) => ({
      tag: bytes[0],
      payload: JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as Record<string, unknown>,
    }));
  }
}

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  FakeSocket.instances = [];
  restoreGlobals();
});

const COVER = {
  width: 1398,
  height: 2034,
  orientation: 'portrait',
  screenId: 1,
  supportsHingeAngle: true,
  hingeAngle: 0,
  hingePose: 'closed',
  tableMode: false,
  tableModeAvailable: false,
};
const INNER_OPEN = {
  ...COVER,
  width: 2007,
  height: 2853,
  screenId: 3,
  hingeAngle: 180,
  hingePose: 'open',
  tableModeAvailable: true,
};

function installBrowser({ duo }: { duo: boolean }) {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', {
    location: {
      href: 'http://localhost:8081/index',
      origin: 'http://localhost:8081',
      protocol: 'http:',
      host: 'localhost:8081',
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal('WebSocket', FakeSocket);
  stubGlobal('fetch', async (url: string) => {
    const { pathname } = new URL(url);
    if (pathname === '/api') {
      return Response.json({
        url: 'https://hub.test/helper/device-1',
        wsUrl: 'wss://hub.test/helper/device-1/ws',
        device: 'device-1',
        basePath: '/',
        gridApiEndpoint: '/grid/api',
        chrome: duo ? { identifier: 'phone15' } : { identifier: 'phone17pro' },
      });
    }
    if (pathname === '/grid/api') {
      return Response.json({
        devices: [{ device: 'device-1', name: duo ? 'iPhone Duo' : 'iPhone 17 Pro', helper: {} }],
      });
    }
    return Response.json({}, { status: 404 });
  });
}

async function connect(options: Partial<DeviceConnectionOptions> = {}) {
  let client!: DeviceClient;
  function Harness(props: Partial<DeviceConnectionOptions>) {
    client = useIosDeviceClient({
      baseUrl: 'https://hub.test',
      device: 'device-1',
      enabled: true,
      streamMode: 'mjpeg',
      ...props,
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness {...options} />);
  });
  await act(async () => {});
  const socket = FakeSocket.instances.find((instance) => instance.url.includes('/helper/ws'));
  if (!socket) throw new Error('The hook did not open the helper input socket');
  await act(async () => socket.open());
  return {
    socket,
    client: () => client,
    update: (props: Partial<DeviceConnectionOptions>) =>
      act(async () => renderer!.update(<Harness {...options} {...props} />)),
  };
}

test('a device without a hinge exposes no hinge state and rotates counterclockwise', async () => {
  installBrowser({ duo: false });
  const { socket, client } = await connect();
  await act(async () =>
    socket.push(0x82, { width: 1206, height: 2622, orientation: 'portrait', screenId: 1 }),
  );
  expect(client().hinge).toBeNull();
  expect(client().screen?.screenId).toBe(1);
  await act(async () => client().rotate());
  expect(socket.frames().at(-1)).toEqual({ tag: 0x07, payload: { orientation: 'landscape_left' } });
});

test('the Duo reports its hinge from the pushed screen config and keeps the flat stream by default', async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  // DeviceKit's cover chrome identifies the Duo before native capability metadata.
  expect(client().hinge).not.toBeNull();
  expect(client().hinge?.angle).toBeUndefined();
  await act(async () => socket.push(0x82, COVER));
  const hinge = client().hinge!;
  expect(hinge.angle).toBe(0);
  expect(hinge.pose).toBe('closed');
  expect(hinge.tableMode).toBe(false);
  expect(hinge.activeScreenId).toBe(1);
  expect(hinge.pending).toBe(false);
  expect(hinge.modelActive).toBe(false);
  expect(hinge.panels).toBeNull();
  expect(hinge.modelUrl).toBe('https://hub.test/grid/api/devicekit-model');
  expect(client().screen?.supportsHingeAngle).toBe(true);
});

test('pose commands go out acknowledged on the input socket and preview until the config confirms them', async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, COVER));
  await act(async () => client().hinge!.setControl({ control: 'pose', value: 'open' }));
  expect(socket.frames().at(-1)).toEqual({
    tag: 0x10,
    payload: { requestId: 1, command: { control: 'pose', value: 'open' } },
  });
  expect(client().hinge?.pending).toBe(true);
  expect(client().hinge?.angle).toBe(180);
  expect(client().hinge?.pose).toBe('open');
  expect(client().hinge?.activeScreenId).toBe(3);

  await act(async () => socket.push(0x90, { requestId: 1, ok: true }));
  expect(client().hinge?.pending).toBe(false);
  // The preview holds until the helper's config catches up, so nothing animates backwards.
  expect(client().hinge?.angle).toBe(180);
  await act(async () => socket.push(0x82, INNER_OPEN));
  expect(client().hinge?.angle).toBe(180);
  expect(client().hinge?.pose).toBe('open');
  expect(client().hinge?.tableModeAvailable).toBe(true);
  expect(client().screen?.screenId).toBe(3);
});

test('a rejected hinge command surfaces its error and drops the preview', async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, INNER_OPEN));
  await act(async () => client().hinge!.setControl({ control: 'angle', value: 90 }));
  expect(client().hinge?.angle).toBe(90);
  expect(client().hinge?.pose).toBeNull();
  await act(async () =>
    socket.push(0x90, { requestId: 1, ok: false, error: 'Simulator could not change the device pose.' }),
  );
  expect(client().hinge?.pending).toBe(false);
  expect(client().hinge?.error).toBe('Simulator could not change the device pose.');
  expect(client().hinge?.angle).toBe(180);
  // The next command clears the error.
  await act(async () => client().hinge!.setControl({ control: 'table', value: true }));
  expect(client().hinge?.error).toBeNull();
  expect(client().hinge?.tableMode).toBe(true);
});

test('the Duo rotates clockwise like Xcode and serve-sim, and a rotation forgets the native preset', async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, INNER_OPEN));
  await act(async () => client().rotate());
  expect(socket.frames().at(-1)).toEqual({ tag: 0x07, payload: { orientation: 'landscape_right' } });
  expect(client().hinge?.physicalPose).toBeNull();
});

test('the 3D preview feeds both panels through the helper mount and parks the flat stream', async () => {
  installBrowser({ duo: true });
  const { socket, client, update } = await connect({ duoPreview: '3d' });
  await act(async () => socket.push(0x82, COVER));
  const hinge = client().hinge!;
  expect(hinge.modelActive).toBe(true);
  expect(hinge.panels).toMatchObject({ url: 'https://hub.test/helper/device-1', mode: 'mjpeg' });
  expect(client().status).toBe('connecting');
  await act(async () => hinge.panels!.onStreamingChange(true));
  expect(client().status).toBe('streaming');
  await act(async () => hinge.panels!.onStreamError('WebRTC streaming failed for this display.'));
  expect(client().status).toBe('error');
  expect(client().error).toBe('WebRTC streaming failed for this display.');

  await update({ duoPreview: '2d' });
  expect(client().hinge?.modelActive).toBe(false);
  expect(client().hinge?.panels).toBeNull();
  expect(client().hinge?.angle).toBe(0);
});

test('raw model input bypasses the display-orientation remap', async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, { ...INNER_OPEN, orientation: 'landscape_left' }));
  await act(async () => client().hinge!.sendModelTouch({ type: 'begin', x: 0.25, y: 0.75, edge: 3 }));
  expect(socket.frames().at(-1)).toEqual({
    tag: 0x03,
    payload: { type: 'begin', x: 0.25, y: 0.75, edge: 3 },
  });
  await act(async () => client().hinge!.sendModelScroll({ dx: 0.1, dy: -0.2, x: 0.5, y: 0.5 }));
  expect(socket.frames().at(-1)).toEqual({ tag: 0x0b, payload: { dx: 0.1, dy: -0.2, x: 0.5, y: 0.5 } });
});
