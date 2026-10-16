import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { IOS_INPUT_UNAVAILABLE_MESSAGE } from '../ios-input-error';
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

async function renderIosClient(inputAdmission: unknown = true, helper: { pid: number; absent?: boolean; discovery?: Promise<void> } = { pid: 1 }) {
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
    constructor(readonly url: string) {
      sockets.push(this);
    }
    sent: ArrayBuffer[] = [];
    send(data: ArrayBuffer) { this.sent.push(data); }
    close() {}
  });
  stubGlobal('EventSource', class {
    close() {}
  });
  stubGlobal('fetch', async (url: string) => {
    const endpoint = new URL(String(url), 'http://localhost:3200');
    if (endpoint.pathname === '/sim/api') {
      await helper.discovery;
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
  function Harness({device = 'DEVICE-A', token = null, enabled = true}: {device?: string; token?: string | null; enabled?: boolean}) {
    client = useIosDeviceClient({ baseUrl: '/sim', device, token, enabled, streamMode: 'mjpeg' });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  const helperSockets = () => sockets.filter((socket) => socket.url.includes('/helper/'));
  return { client: () => client, helperSockets, changeDevice: (device: string) => renderer!.update(<Harness device={device} />), changeOptions: (options: {device?: string; token?: string | null; enabled?: boolean}) => renderer!.update(<Harness {...options} />) };
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
  const { client, helperSockets } = await renderIosClient(true, helper);
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
  const { client, helperSockets } = await renderIosClient(true, helper);
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
  const { client, helperSockets, changeDevice } = await renderIosClient(true, helper);
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

function buttons(socket: FakeSocket) {
  return socket.sent.filter(data => new Uint8Array(data)[0] === 0x04)
    .map(data => JSON.parse(new TextDecoder().decode(new Uint8Array(data).subarray(1))).button);
}

async function admit(socket: FakeSocket) {
  socket.readyState = 1;
  await act(async () => socket.onopen?.());
  expect(buttons(socket)).toEqual([]);
  await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
}

test('fresh controls entered before discovery wait for input admission', async () => {
  let release!: () => void;
  const helper = { pid: 1, discovery: new Promise<void>(resolve => { release = resolve; }) };
  const { client, helperSockets } = await renderIosClient(true, helper);
  expect(helperSockets()).toHaveLength(0);
  await act(async () => client().pressButton('home'));
  await act(async () => release());
  const socket = helperSockets()[0]!;
  await admit(socket);
  expect(buttons(socket)).toEqual(['home']);
});

for (const replaced of [false, true]) {
  test(`a discovery gap ${replaced ? 'drops commands for a replaced helper' : 'retains fresh commands for the same helper'}`, async () => {
    const helper = { pid: 1, absent: false };
    const { client, helperSockets } = await renderIosClient(true, helper);
    // Queue one command before admission, then remove the helper from discovery.
    await act(async () => client().pressButton('home'));
    helper.absent = true;
    await act(async () => helperSockets()[0]!.onclose?.({ code: 1006, reason: '' }));
    await act(async () => new Promise(resolve => setTimeout(resolve, 15)));
    expect(client().status).toBe('connecting');
    await act(async () => client().pressButton('power'));
    helper.absent = false;
    if (replaced) helper.pid++;
    await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
    const socket = helperSockets().at(-1)!;
    await admit(socket);
    expect(buttons(socket)).toEqual(replaced ? [] : ['home', 'lock']);
  });
}

for (const changed of ['device', 'token', 'disabled'] as const) {
  test(`early input is discarded when ${changed} changes`, async () => {
    let release!: () => void;
    const helper = { pid: 1, discovery: new Promise<void>(resolve => { release = resolve; }) };
    const { client, helperSockets, changeOptions } = await renderIosClient(true, helper);
    await act(async () => client().pressButton('home'));
    await act(async () => changeOptions(changed === 'device' ? { device: 'DEVICE-B' } : changed === 'token' ? { token: 'new-token' } : { enabled: false }));
    if (changed === 'disabled') await act(async () => changeOptions({ enabled: true }));
    await act(async () => client().pressButton('power'));
    await act(async () => release());
    const socket = helperSockets().at(-1)!;
    await admit(socket);
    expect(buttons(socket)).toEqual(['lock']);
  });
}

for (const expired of [false, true]) {
  test(`early controls ${expired ? 'expire at their original deadline' : 'retain the 32-message capacity limit'}`, async () => {
    let release!: () => void;
    let now = 0;
    const NativeDate = Date;
    stubGlobal('Date', class extends NativeDate { static now() { return now; } });
    const helper = { pid: 1, discovery: new Promise<void>(resolve => { release = resolve; }) };
    const { client, helperSockets } = await renderIosClient(true, helper);
    await act(async () => { for (let index = 0; index < 40; index++) client().pressButton('home'); });
    if (expired) now = 1501;
    await act(async () => release());
    const socket = helperSockets()[0]!;
    await admit(socket);
    expect(buttons(socket)).toEqual(expired ? [] : Array(32).fill('home'));
  });
}
