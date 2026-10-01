import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { IOS_INPUT_UNAVAILABLE_MESSAGE } from '../ios-input-error.js';
import { type DeviceClient } from '../types.js';
import { useIosDeviceClient } from '../useIosDevice.js';
import { createGlobalStubs } from './test-globals.js';

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

async function renderIosClient(inputAdmission: unknown = true) {
  const sockets: FakeSocket[] = [];
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
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
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
      const device = endpoint.searchParams.get('device');
      return Response.json({inputAdmission: inputAdmission === false ? undefined : inputAdmission, device,
        url: `http://localhost:3200/sim/helper/${device}`,
        streamUrl: `http://localhost:3200/sim/helper/${device}/stream.mjpeg`,
        wsUrl: `ws://localhost:3200/sim/helper/${device}/ws`});
    }
    return Response.json({ devices: [] });
  });

  let client!: DeviceClient;
  function Harness({device = 'DEVICE-A'}: {device?: string}) {
    client = useIosDeviceClient({ baseUrl: '/sim', device, streamMode: 'mjpeg' });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  const helperSockets = () => sockets.filter((socket) => socket.url.includes('/helper/'));
  return { client: () => client, helperSockets, changeDevice: (device: string) => renderer!.update(<Harness device={device} />) };
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

for (const inputAdmission of [true, 'true']) {
  test(`screen config cannot clear a refusal before admission (${inputAdmission})`, async () => {
    const { client, helperSockets } = await renderIosClient(inputAdmission);
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
}



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


test('retired callbacks and paced keys never cross device identity', async () => {
  const {client, helperSockets, changeDevice} = await renderIosClient();
  const a = helperSockets()[0]!; a.readyState = 1;
  await act(async () => a.onmessage?.({data: Uint8Array.of(0x83).buffer}));
  const old = client();
  await act(async () => {
    old.sendKeyEvents(Array.from({length: 100}, (_, i) => ({type: i % 2 ? 'up' as const : 'down' as const, usage: 4})));
    changeDevice('DEVICE-B');
  });
  const b = helperSockets().find(socket => socket.url.includes('DEVICE-B'))!; b.readyState = 1;
  await act(async () => b.onmessage?.({data: Uint8Array.of(0x83).buffer}));
  await act(async () => {old.sendKey({phase:'down',code:'KeyA',key:'a',repeat:false}); await new Promise(resolve => setTimeout(resolve,30));});
  expect(b.sent.filter(data => new Uint8Array(data)[0] === 6)).toHaveLength(0);
  await act(async () => client().sendKey({phase:'down',code:'KeyB',key:'b',repeat:false}));
  expect(b.sent.filter(data => new Uint8Array(data)[0] === 6)).toHaveLength(1);

});
