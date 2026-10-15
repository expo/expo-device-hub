import { afterEach, expect, spyOn, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { IOS_INPUT_UNAVAILABLE_MESSAGE } from '../ios-input-error';
import { DeviceScreen } from '../DeviceScreen';
import { type DeviceClient } from '../types';
import { useIosDeviceClient } from '../useIosDevice';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

const CLIENT_LIMIT_REASON = 'Simulator input unavailable; retry after other clients disconnect';

type FakeSocket = {
  url: string;
  readyState: number;
  sent: ArrayBuffer[];
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
};

async function renderIosClient(inputAdmission: unknown = true, { renderScreen = false, helper = { pid: 1 } as { pid: number; absent?: boolean } } = {}) {
  const sockets: FakeSocket[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const addListener = (name: string, callback: () => void) => {
    const current = listeners.get(name) ?? new Set();
    current.add(callback); listeners.set(name, current);
  };
  const removeListener = (name: string, callback: () => void) => listeners.get(name)?.delete(callback);
  const realTimeout = globalThis.setTimeout;
  stubGlobal('setTimeout', (callback: () => void, delay: number) => realTimeout(callback, delay === 13_000 ? 20 : delay === 1500 ? 10 : delay === 1000 || delay === 5000 ? 20 : delay));
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', {
    location: {
      href: 'http://localhost:3200/',
      origin: 'http://localhost:3200',
      protocol: 'http:',
      host: 'localhost:3200',
    },
    addEventListener: addListener,
    removeEventListener: removeListener,
    setTimeout,
    clearTimeout,
  });
  stubGlobal('document', { hidden: false, addEventListener: addListener, removeEventListener: removeListener });
  stubGlobal('WebSocket', class {
    readyState = 0;
    sent: ArrayBuffer[] = [];
    constructor(readonly url: string) {
      sockets.push(this);
    }
    send(data: ArrayBuffer) { this.sent.push(data); }
    close() {}
  });
  stubGlobal('EventSource', class {
    close() {}
  });
  stubGlobal('fetch', async (url: string) => {
    const endpoint = new URL(String(url), 'http://localhost:3200');
    if (endpoint.pathname === '/sim/api') {
      if (helper.absent) return Response.json(null);
      const device = endpoint.searchParams.get('device');
      return Response.json({inputAdmission: inputAdmission === false ? undefined : inputAdmission, device, pid: helper.pid,
        url: `http://localhost:3200/sim/helper/${device}`,
        streamUrl: `http://localhost:3200/sim/helper/${device}/stream.mjpeg`,
        wsUrl: `ws://localhost:3200/sim/helper/${device}/ws`});
    }
    return Response.json({ devices: [] });
  });

  let client!: DeviceClient;
  function Harness({device = 'DEVICE-A'}: {device?: string}) {
    client = useIosDeviceClient({ baseUrl: '/sim', device, streamMode: 'mjpeg' });
    return renderScreen ? <DeviceScreen client={client} /> : null;
  }
  const surface = {
    focus() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 200 }),
  };
  await act(async () => {
    renderer = create(<Harness />, {
      createNodeMock: node => node.type === 'div' ? surface : null,
    });
  });
  const helperSockets = () => sockets.filter((socket) => socket.url.includes('/helper/'));
  return { client: () => client, helperSockets, dispatch: (name: string) => listeners.get(name)?.forEach(callback => callback()), changeDevice: (device: string) => renderer!.update(<Harness device={device} />) };
}

function configFrame(config: object): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(config));
  const bytes = new Uint8Array(1 + json.length);
  bytes[0] = 0x82;
  bytes.set(json, 1);
  return bytes.buffer;
}

test('a rejected input socket reports inputError until a later socket is admitted', async () => {
  const { client, helperSockets } = await renderIosClient();
  expect(helperSockets()).toHaveLength(1);
  expect(client().inputError).toBeNull();

  await act(async () => helperSockets()[0]!.onclose?.({ code: 1013, reason: CLIENT_LIMIT_REASON }));
  expect(client().inputError).toBeNull();
  await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);

  // A plain drop during the retry keeps the rejection visible.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(helperSockets()).toHaveLength(2);
  await act(async () => helperSockets()[1]!.onclose?.({ code: 1006, reason: '' }));
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);

  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const socket = helperSockets()[2]!;
  socket.readyState = 1;
  await act(async () => socket.onopen?.());
  await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
  expect(client().inputError).toBe(CLIENT_LIMIT_REASON);
  await act(async () => socket.onmessage?.({data: Uint8Array.of(0x83).buffer}));
  expect(client().inputError).toBeNull();
});

test('serve-sim inputUnavailable in the screen config reports inputError', async () => {
  const { client, helperSockets } = await renderIosClient();
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => socket.onopen?.());

  await act(async () =>
    socket.onmessage?.({
      data: configFrame({ width: 390, height: 844, orientation: 'portrait', inputUnavailable: true }),
    }),
  );
  expect(client().inputError).toBe(IOS_INPUT_UNAVAILABLE_MESSAGE);

  await act(async () =>
    socket.onmessage?.({
      data: configFrame({ width: 390, height: 844, orientation: 'portrait', inputUnavailable: false }),
    }),
  );
  expect(client().inputError).toBeNull();
});

test('malformed config frames cannot admit modern input or set keyboard state', async () => {
  const {client, helperSockets} = await renderIosClient(); const socket = helperSockets()[0]!;
  socket.readyState = 1; await act(async () => socket.onopen?.());
  expect(client().hardwareKeyboardConnected).toBeNull();
  await act(async () => socket.onmessage?.({data: configFrame({width: '390', height: 844})}));
  expect(client().hardwareKeyboardConnected).toBeNull();
  await act(async () => socket.onmessage?.({data: Uint8Array.of(0x83).buffer}));
  expect(client().hardwareKeyboardConnected).toBe(false);
});

test('legacy OPEN sends input while recovery waits out the refusal grace', async () => {
  const {client, helperSockets} = await renderIosClient(false); const socket = helperSockets()[0]!;
  socket.readyState = 1; await act(async () => socket.onopen?.());
  expect(client().hardwareKeyboardConnected).toBe(false);
});

test('screen config cannot clear a refusal before modern admission', async () => {
    const { client, helperSockets } = await renderIosClient();
    await act(async () => helperSockets()[0]!.onclose?.({ code: 1013, reason: CLIENT_LIMIT_REASON }));
    await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
    const socket = helperSockets()[1]!;
    socket.readyState = 1;
    await act(async () => socket.onopen?.());
    await act(async () => socket.onmessage?.({ data: configFrame({ width: 390, height: 844, orientation: 'portrait' }) }));
    await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
    expect(client().inputError).toBe(CLIENT_LIMIT_REASON);
    expect(client().hardwareKeyboardConnected).toBeNull();
    await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
    expect(client().inputError).toBeNull();
    expect(client().hardwareKeyboardConnected).toBe(false);
});


test('an overload warning survives admission but expires without changing owners', async () => {
  const { client, helperSockets } = await renderIosClient();
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  const reason = 'Simulator input queue full; send smaller batches or slow down';
  await act(async () => socket.onclose?.({ code: 1013, reason }));
  expect(client().inputError).toBe(reason);
  await act(async () => new Promise(resolve => setTimeout(resolve, 12)));
  const retry = helperSockets()[1]!;
  retry.readyState = 1;
  await act(async () => retry.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  expect(client().inputError).toBe(reason);
  await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
  expect(client().inputError).toBeNull();
});

test('an overload warning outlives a helper restart at the same URL', async () => {
  const helper = { pid: 1 };
  const { client, helperSockets } = await renderIosClient(true, { helper });
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  const reason = 'Simulator input queue full; send smaller batches or slow down';
  helper.pid = 2;
  await act(async () => socket.onclose?.({ code: 1013, reason }));
  await act(async () => new Promise(resolve => setTimeout(resolve, 12)));
  expect(helperSockets().length).toBeGreaterThan(2);
  expect(client().inputError).toBe(reason);
  await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
  expect(client().inputError).toBeNull();
});

test('an overload warning outlives a helper that is briefly absent', async () => {
  const helper = { pid: 1, absent: false };
  const { client, helperSockets } = await renderIosClient(true, { helper });
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  const reason = 'Simulator input queue full; send smaller batches or slow down';
  helper.absent = true;
  await act(async () => socket.onclose?.({ code: 1013, reason }));
  await act(async () => new Promise(resolve => setTimeout(resolve, 12)));
  expect(client().status).toBe('connecting');
  expect(client().inputError).toBe(reason);
  await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
  expect(client().inputError).toBeNull();
});

test('an overload warning stays with its device', async () => {
  const helper = { pid: 1, absent: false };
  const { client, helperSockets, changeDevice } = await renderIosClient(true, { helper });
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
  const reason = 'Simulator input queue full; send smaller batches or slow down';
  await act(async () => socket.onclose?.({ code: 1013, reason }));
  expect(client().inputError).toBe(reason);
  helper.absent = true;
  await act(async () => changeDevice('DEVICE-B'));
  expect(client().inputError).toBeNull();
});

test('retired callbacks and paced keys never cross device identity', async () => {
  const {client, helperSockets, changeDevice} = await renderIosClient();
  const a = helperSockets()[0]!; a.readyState = 1;
  await act(async () => a.onmessage?.({data: Uint8Array.of(0x83).buffer}));
  const old = client();
  await act(async () => {
    old.sendKeyEvents!(Array.from({length: 100}, (_, i) => ({type: i % 2 ? 'up' as const : 'down' as const, usage: 4})));
    changeDevice('DEVICE-B');
  });
  const b = helperSockets().find(socket => socket.url.includes('DEVICE-B'))!; b.readyState = 1;
  await act(async () => b.onmessage?.({data: Uint8Array.of(0x83).buffer}));
  await act(async () => {old.sendKey({phase:'down',code:'KeyA',key:'a',repeat:false}); await new Promise(resolve => setTimeout(resolve,30));});
  expect(b.sent.filter(data => new Uint8Array(data)[0] === 6)).toHaveLength(0);
  await act(async () => {client().sendKey({phase:'down',code:'KeyB',key:'b',repeat:false});});
  expect(b.sent.filter(data => new Uint8Array(data)[0] === 6)).toHaveLength(1);

});


for (const event of ['blur', 'visibilitychange', 'pagehide']) {
  test(`${event} cancels a paced batch and releases only its held keys`, async () => {
    const { client, helperSockets, dispatch } = await renderIosClient();
    const socket = helperSockets()[0]!;
    socket.readyState = 1;
    await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
    await act(async () => {
      client().sendKeyEvents!([{ type: 'down', usage: 225 }, { type: 'down', usage: 4 }, { type: 'up', usage: 4 }, { type: 'up', usage: 225 }]);
      if (event === 'visibilitychange') Object.assign(document, { hidden: true });
      dispatch(event);
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    const keys = socket.sent.filter(data => new Uint8Array(data)[0] === 6)
      .map(data => JSON.parse(new TextDecoder().decode(new Uint8Array(data).slice(1))));
    expect(keys).toEqual([{ type: 'down', usage: 225 }, { type: 'up', usage: 225 }]);
  });
}

test('blur before admission discards pending keys instead of typing them on recovery', async () => {
  const { client, helperSockets, dispatch } = await renderIosClient();
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => {
    client().sendKeyEvents!([{ type: 'down', usage: 4 }, { type: 'up', usage: 4 }]);
    dispatch('blur');
    socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  expect(socket.sent.filter(data => new Uint8Array(data)[0] === 6)).toHaveLength(0);
});

function gestureMessages(socket: FakeSocket) {
  return socket.sent.filter(data => [3, 5].includes(new Uint8Array(data)[0]!))
    .map(data => JSON.parse(new TextDecoder().decode(new Uint8Array(data).slice(1))));
}

for (const gesture of ['single', 'multi'] as const) {
  for (const cancellation of ['surface blur', 'blur', 'visibilitychange', 'pagehide']) {
    test(`${cancellation} abandons an unadmitted ${gesture} gesture`, async () => {
      const { helperSockets, dispatch } = await renderIosClient(true, { renderScreen: true });
      const socket = helperSockets()[0]!;
      socket.readyState = 1;
      const surface = renderer!.root.findByProps({ role: 'application' });
      await act(async () => surface.props.onPointerDown({
        pointerId: 1, pointerType: 'mouse', button: 0,
        clientX: 20, clientY: 60, altKey: gesture === 'multi', shiftKey: false,
        preventDefault() {},
      }));
      await act(async () => {
        if (cancellation === 'surface blur') surface.props.onBlur();
        else {
          if (cancellation === 'visibilitychange') Object.assign(document, { hidden: true });
          dispatch(cancellation);
        }
        socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
      });
      expect(gestureMessages(socket)).toEqual([]);
    });
  }

  test(`surface blur still releases an admitted ${gesture} gesture`, async () => {
    const { helperSockets } = await renderIosClient(true, { renderScreen: true });
    const socket = helperSockets()[0]!;
    socket.readyState = 1;
    await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
    const surface = renderer!.root.findByProps({ role: 'application' });
    await act(async () => surface.props.onPointerDown({
      pointerId: 1, pointerType: 'mouse', button: 0,
      clientX: 20, clientY: 60, altKey: gesture === 'multi', shiftKey: false,
      preventDefault() {},
    }));
    await act(async () => surface.props.onBlur());
    expect(gestureMessages(socket).map(message => message.type)).toEqual(['begin', 'end']);
  });
}

test('a completed tap before admission still reaches the device', async () => {
  const { client, helperSockets } = await renderIosClient();
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  await act(async () => {
    client().sendTouch({ phase: 'begin', x: 0.2, y: 0.3 });
    client().sendTouch({ phase: 'end', x: 0.2, y: 0.3 });
    socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
  });
  expect(gestureMessages(socket).map(message => message.type)).toEqual(['begin', 'end']);
});

for (const gesture of ['single', 'multi'] as const) {
  for (const cancellation of ['surface blur', 'blur'] as const) {
    test(`${cancellation} preserves a completed unadmitted ${gesture} gesture`, async () => {
      const { helperSockets, dispatch } = await renderIosClient(true, { renderScreen: true });
      const socket = helperSockets()[0]!;
      socket.readyState = 1;
      const surface = renderer!.root.findByProps({ role: 'application' });
      const pointer = { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 20, clientY: 60,
        altKey: gesture === 'multi', shiftKey: false, preventDefault() {} };
      await act(async () => { surface.props.onPointerDown(pointer); surface.props.onPointerUp(pointer); });
      await act(async () => {
        if (cancellation === 'surface blur') surface.props.onBlur();
        else dispatch(cancellation);
        socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
      });
      expect(gestureMessages(socket).map(message => message.type)).toEqual(['begin', 'end']);
    });
  }
}

test('blur preserves completed input only for its original queue lifetime', async () => {
  const { client, helperSockets, dispatch } = await renderIosClient();
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  const clock = spyOn(Date, 'now').mockReturnValue(1000);
  try {
    await act(async () => {
      client().sendTouch({ phase: 'begin', x: 0.2, y: 0.3 });
      client().sendTouch({ phase: 'end', x: 0.2, y: 0.3 });
      dispatch('blur');
      clock.mockReturnValue(2501);
      socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
    });
    expect(gestureMessages(socket)).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

test('surface blur keeps a completed tap while abandoning the following drag', async () => {
  const { helperSockets } = await renderIosClient(true, { renderScreen: true });
  const socket = helperSockets()[0]!;
  socket.readyState = 1;
  const surface = renderer!.root.findByProps({ role: 'application' });
  const pointer = { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 20, clientY: 60,
    altKey: false, shiftKey: false, preventDefault() {} };
  await act(async () => {
    surface.props.onPointerDown(pointer);
    surface.props.onPointerUp(pointer);
    surface.props.onPointerDown({ ...pointer, pointerId: 2, clientX: 40 });
    surface.props.onBlur();
    socket.onmessage?.({ data: Uint8Array.of(0x83).buffer });
  });
  expect(gestureMessages(socket)).toEqual([
    { type: 'begin', x: 0.2, y: 0.3 },
    { type: 'end', x: 0.2, y: 0.3 },
  ]);
});
