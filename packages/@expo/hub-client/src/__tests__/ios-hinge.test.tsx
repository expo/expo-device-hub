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

// Xcode 27.1's DeviceKit profiles for the Duo: the cover is the primary, the inner display a variant.
const DUO_CHROME = {
  identifier: 'phone15',
  screen: { x: 34, y: 23, width: 466, height: 678 },
  screenRadius: 33.5,
  screenCornerRadii: { topLeft: 8, topRight: 59, bottomRight: 59, bottomLeft: 8 },
  screenId: 1,
  displayVariants: {
    3: {
      identifier: 'phone14',
      screen: { x: 27, y: 27, width: 626, height: 890 },
      screenRadius: 51.5,
      screenCornerRadii: { topLeft: 51.5, topRight: 51.5, bottomRight: 51.5, bottomLeft: 51.5 },
      screenId: 3,
    },
  },
};

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

/** Holds device-2's `/api` answer so a test can observe the switch before it resolves. */
const gate: { hold: boolean; release: (() => void) | null } = { hold: false, release: null };

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
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/api') {
      // device-1 is the Duo under test (or a plain iPhone); device-2 is always a plain iPhone.
      const device = searchParams.get('device') ?? 'device-1';
      const foldable = duo && device === 'device-1';
      if (device === 'device-2' && gate.hold) {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      }
      return Response.json({
        url: `https://hub.test/helper/${device}`,
        wsUrl: `wss://hub.test/helper/${device}/ws`,
        device,
        basePath: '/',
        gridApiEndpoint: '/grid/api',
        chrome: foldable ? DUO_CHROME : { identifier: 'phone17pro', screen: { width: 402, height: 874 }, screenRadius: 62 },
      });
    }
    if (pathname === '/grid/api') {
      return Response.json({
        devices: [
          { device: 'device-1', name: duo ? 'iPhone Duo' : 'iPhone 17 Pro', helper: {} },
          { device: 'device-2', name: 'iPhone 17 Pro', helper: {} },
        ],
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
  // Only the Duo trades the generic iPhone shape for its own glass corners.
  expect(client().displayCorners).toBeNull();
  await act(async () => client().rotate());
  expect(socket.frames().at(-1)).toEqual({ tag: 0x07, payload: { orientation: 'landscape_left' } });
});

test("the flat view gets the active display's glass corners, turned with the device", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  // Before the first config the cover profile applies.
  expect(client().displayCorners).toEqual({ topLeft: 8 / 466, topRight: 59 / 466, bottomRight: 59 / 466, bottomLeft: 8 / 466 });
  await act(async () => socket.push(0x82, INNER_OPEN));
  expect(client().displayCorners).toEqual({ topLeft: 51.5 / 626, topRight: 51.5 / 626, bottomRight: 51.5 / 626, bottomLeft: 51.5 / 626 });
  await act(async () => socket.push(0x82, { ...COVER, orientation: 'landscape_right' }));
  expect(client().displayCorners).toEqual({ topLeft: 59 / 678, topRight: 59 / 678, bottomRight: 8 / 678, bottomLeft: 8 / 678 });
  // Landscape dimensions without an orientation field still turn the corners.
  await act(async () =>
    socket.push(0x82, { ...COVER, width: 2034, height: 1398, orientation: undefined }),
  );
  expect(client().displayCorners).toEqual({ topLeft: 8 / 678, topRight: 8 / 678, bottomRight: 59 / 678, bottomLeft: 59 / 678 });
});

test('the Duo reports its hinge from the pushed screen config and keeps the flat stream by default', async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  // DeviceKit's cover chrome identifies the Duo before native capability metadata.
  expect(client().hinge).not.toBeNull();
  expect(client().hinge?.angle).toBeUndefined();
  expect(client().hinge?.supported).toBeUndefined();
  await act(async () => socket.push(0x82, COVER));
  const hinge = client().hinge!;
  expect(hinge.supported).toBe(true);
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

test('switching to another simulator forgets the previous screen config at once', async () => {
  installBrowser({ duo: true });
  const { socket, client, update } = await connect({ duoPreview: '3d' });
  await act(async () => socket.push(0x82, INNER_OPEN));
  expect(client().hinge?.modelActive).toBe(true);

  gate.hold = true;
  await update({ device: 'device-2' });
  await act(async () => {});
  // Before the new device's config resolves, nothing of the old Duo remains:
  // no hinge, no parked stream, no stale screen under the new name.
  expect(client().status).toBe('connecting');
  expect(client().screen).toBeNull();
  expect(client().hinge).toBeNull();
  gate.hold = false;
  await act(async () => gate.release?.());
  await act(async () => {});
  // The old Duo config must not classify the plain iPhone or park its stream
  // while its own helper has not pushed a config yet.
  expect(client().screen).toBeNull();
  expect(client().hinge).toBeNull();
  const next = FakeSocket.instances.find((instance) => instance.url.includes('device-2'));
  expect(next).toBeDefined();
  await act(async () => next!.open());
  await act(async () => next!.push(0x82, { width: 1206, height: 2622, orientation: 'portrait', screenId: 1 }));
  expect(client().screen?.width).toBe(1206);
  expect(client().hinge).toBeNull();
});

test('a rejected preset restores the 3D view it replaced, unless a rotation superseded it', async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, INNER_OPEN));
  const openView = client().hinge!.view;
  expect(openView.fixedLeftFold).toBeUndefined();

  await act(async () => client().hinge!.setControl({ control: 'pose', value: 'laptop' }));
  expect(client().hinge?.view.fixedLeftFold).toBeDefined();
  await act(async () =>
    socket.push(0x90, { requestId: 1, ok: false, error: 'Simulator could not change the device pose.' }),
  );
  expect(client().hinge?.error).toBe('Simulator could not change the device pose.');
  expect(client().hinge?.view).toEqual(openView);

  // A rotation during the request owns the view; the rejection keeps it.
  await act(async () => client().hinge!.setControl({ control: 'pose', value: 'laptop' }));
  await act(async () => client().rotate());
  const rotatedView = client().hinge!.view;
  expect(rotatedView).not.toEqual(openView);
  await act(async () => socket.push(0x90, { requestId: 2, ok: false, error: 'Rejected' }));
  expect(client().hinge?.view).toEqual(rotatedView);

  // An acknowledged preset keeps its own view: a later failed edit does not undo it.
  await act(async () => client().hinge!.setControl({ control: 'pose', value: 'open' }));
  await act(async () => socket.push(0x90, { requestId: 3, ok: true }));
  const acknowledged = client().hinge!.view;
  await act(async () => client().hinge!.setControl({ control: 'angle', value: 120 }));
  await act(async () => socket.push(0x90, { requestId: 4, ok: false, error: 'Rejected' }));
  expect(client().hinge?.view).toEqual(acknowledged);
  await act(async () => socket.push(0x82, INNER_OPEN));

  // A preset queued behind a failing edit is discarded with the queue, so its
  // view goes too.
  const beforeEdit = client().hinge!.view;
  await act(async () => client().hinge!.setControl({ control: 'angle', value: 100 }));
  await act(async () => client().hinge!.setControl({ control: 'pose', value: 'laptop' }));
  expect(client().hinge?.view.fixedLeftFold).toBeDefined();
  expect(socket.frames().filter((frame) => frame.tag === 0x10)).toHaveLength(5);
  await act(async () => socket.push(0x90, { requestId: 5, ok: false, error: 'Rejected' }));
  expect(client().hinge?.pending).toBe(false);
  expect(socket.frames().filter((frame) => frame.tag === 0x10)).toHaveLength(5);
  expect(client().hinge?.view).toEqual(beforeEdit);
});

for (const failure of ['rejection', 'timeout', 'disconnect'] as const) {
  test(`a queued preset ${failure} restores the last accepted preset's view`, async () => {
    installBrowser({ duo: true });
    const deadlines: (() => void)[] = [];
    const nativeTimeout = setTimeout;
    if (failure === 'timeout') {
      stubGlobal('setTimeout', (callback: () => void, ms: number) => {
        if (ms === 5_000) {
          deadlines.push(callback);
          return 0;
        }
        return nativeTimeout(callback, ms);
      });
    }
    const { socket, client } = await connect();
    await act(async () => socket.push(0x82, COVER));
    await act(async () => client().hinge!.setControl({ control: 'pose', value: 'open' }));
    const acceptedView = client().hinge!.view;
    await act(async () => client().hinge!.setControl({ control: 'pose', value: 'laptop' }));
    const laptopView = client().hinge!.view;
    expect(laptopView).not.toEqual(acceptedView);
    await act(async () => socket.push(0x82, INNER_OPEN));
    await act(async () => socket.push(0x90, { requestId: 1, ok: true }));
    expect(socket.frames().at(-1)?.payload).toEqual({
      requestId: 2,
      command: { control: 'pose', value: 'laptop' },
    });
    // Acknowledging Open must not interrupt the optimistic Laptop preview.
    expect(client().hinge?.view).toEqual(laptopView);
    await act(async () => {
      if (failure === 'rejection') socket.push(0x90, { requestId: 2, ok: false, error: 'Rejected' });
      else if (failure === 'timeout') deadlines.at(-1)!();
      else socket.onclose?.();
    });
    expect(client().hinge?.pending).toBe(false);
    expect(client().hinge?.error).toBeTruthy();
    expect(client().hinge?.pose).toBe('open');
    expect(client().hinge?.view).toEqual(acceptedView);
  });
}

test('a rotation supersedes recovery even when an earlier queued preset succeeds', async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, COVER));
  await act(async () => client().hinge!.setControl({ control: 'pose', value: 'open' }));
  await act(async () => client().hinge!.setControl({ control: 'pose', value: 'laptop' }));
  await act(async () => client().rotate());
  const rotatedView = client().hinge!.view;
  await act(async () => socket.push(0x82, INNER_OPEN));
  await act(async () => socket.push(0x90, { requestId: 1, ok: true }));
  await act(async () => socket.push(0x90, { requestId: 2, ok: false, error: 'Rejected' }));
  expect(client().hinge?.view).toEqual(rotatedView);
});

test('a preset rejected after a rotation restores the turned view', async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, COVER));
  // Open is accepted, but the helper still reports Closed when the user rotates.
  await act(async () => client().hinge!.setControl({ control: 'pose', value: 'open' }));
  await act(async () => socket.push(0x90, { requestId: 1, ok: true }));
  await act(async () => client().rotate());
  const rotatedView = client().hinge!.view;
  await act(async () => client().hinge!.setControl({ control: 'pose', value: 'laptop' }));
  expect(client().hinge?.view).not.toEqual(rotatedView);
  await act(async () => socket.push(0x90, { requestId: 2, ok: false, error: 'Rejected' }));
  expect(client().hinge?.view).toEqual(rotatedView);
});

test('a preset from before a rotation, accepted later, keeps the turned recovery view', async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, COVER));
  await act(async () => client().hinge!.setControl({ control: 'pose', value: 'open' }));
  await act(async () => client().rotate());
  const rotatedView = client().hinge!.view;
  // Laptop queues behind Open; accepting Open must not drop the turn from recovery.
  await act(async () => client().hinge!.setControl({ control: 'pose', value: 'laptop' }));
  await act(async () => socket.push(0x90, { requestId: 1, ok: true }));
  expect(socket.frames().at(-1)?.payload).toEqual({
    requestId: 2,
    command: { control: 'pose', value: 'laptop' },
  });
  await act(async () => socket.push(0x90, { requestId: 2, ok: false, error: 'Rejected' }));
  expect(client().hinge?.view).toEqual(rotatedView);
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

for (const duo of [true, false]) {
  test(`fast Rotate presses advance from the last request on ${duo ? 'the Duo' : 'other devices'}, like serve-sim`, async () => {
    installBrowser({ duo });
    const { socket, client } = await connect();
    await act(async () =>
      socket.push(0x82, duo ? INNER_OPEN : { width: 1206, height: 2622, orientation: 'portrait', screenId: 1 }),
    );
    // Both presses land before the helper confirms the first one.
    await act(async () => client().rotate());
    await act(async () => client().rotate());
    const orientations = socket
      .frames()
      .filter((frame) => frame.tag === 0x07)
      .map((frame) => frame.payload.orientation);
    expect(orientations).toEqual(
      duo ? ['landscape_right', 'portrait_upside_down'] : ['landscape_left', 'portrait_upside_down'],
    );
  });
}

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
