import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { INPUT_DISCONNECTED_MESSAGE } from '../ordered-keyboard-input';
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

type FakeSocket = {
  url: string;
  readyState: number;
  sent: ArrayBuffer[];
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
};

type Flags = { inputPaste?: boolean; inputCopy?: boolean };

async function renderClient(flags: Flags = { inputPaste: true, inputCopy: true }) {
  const sockets: FakeSocket[] = [];
  const copies: Array<{ url: string; init?: RequestInit }> = [];
  const copyResponses: Response[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const realTimeout = globalThis.setTimeout;
  // The input socket reconnects after 1.5 s.
  stubGlobal('setTimeout', (callback: () => void, delay: number) => realTimeout(callback, delay === 1500 ? 10 : delay));
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', {
    location: { href: 'http://localhost:3200/', origin: 'http://localhost:3200', protocol: 'http:', host: 'localhost:3200' },
    addEventListener: (name: string, callback: () => void) => {
      listeners.set(name, (listeners.get(name) ?? new Set()).add(callback));
    },
    removeEventListener: (name: string, callback: () => void) => listeners.get(name)?.delete(callback),
    setTimeout,
    clearTimeout,
  });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal('WebSocket', class {
    readyState = 0;
    sent: ArrayBuffer[] = [];
    onopen?: () => void;
    constructor(readonly url: string) { sockets.push(this); }
    send(data: ArrayBuffer) { this.sent.push(data); }
    close() {}
  });
  stubGlobal('EventSource', class { close() {} });
  stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const endpoint = new URL(String(url), 'http://localhost:3200');
    if (endpoint.pathname === '/sim/api') {
      const device = endpoint.searchParams.get('device');
      return Response.json({
        inputAdmission: true, ...flags, device, execToken: 'exec-token',
        url: `http://localhost:3200/sim/helper/${device}`,
        streamUrl: `http://localhost:3200/sim/helper/${device}/stream.mjpeg`,
        wsUrl: `ws://localhost:3200/sim/helper/${device}/ws`,
      });
    }
    if (endpoint.pathname === '/sim/api/pasteboard') {
      copies.push({ url: String(url), init });
      return copyResponses.shift() ?? Response.json({ ok: true, text: 'copied' });
    }
    return Response.json({ devices: [] });
  });

  let client!: DeviceClient;
  function Harness({ device = 'DEVICE-A' }: { device?: string }) {
    client = useIosDeviceClient({ baseUrl: '/sim', device, streamMode: 'mjpeg' });
    return null;
  }
  await act(async () => { renderer = create(<Harness />); });
  const helperSockets = () => sockets.filter((socket) => socket.url.includes('/helper/'));
  const admit = async (socket = helperSockets().at(-1)!) => {
    socket.readyState = 1;
    await act(async () => socket.onmessage?.({ data: Uint8Array.of(0x83).buffer }));
    return socket;
  };
  // serve-sim pushes the config of a replacement helper on the exec-ws config subscription.
  const pushConfig = async (value: object) => {
    const control = sockets.find((socket) => socket.url.endsWith('/exec-ws'))!;
    if (control.readyState !== 1) {
      control.readyState = 1;
      await act(async () => {
        control.onopen?.();
        control.onmessage?.({ data: JSON.stringify({ ready: true }) });
      });
    }
    const subscription = (control.sent as unknown[])
      .map((data) => JSON.parse(String(data)) as { sub?: number; path?: string })
      .find((message) => message.path?.includes('/api/events'))!;
    await act(async () => control.onmessage?.({
      data: JSON.stringify({ sub: subscription.sub, data: `data: ${JSON.stringify(value)}\n\n` }),
    }));
  };
  return {
    client: () => client,
    helperSockets,
    admit,
    pushConfig,
    copies,
    copyResponses,
    dispatch: (name: string) => listeners.get(name)?.forEach((callback) => callback()),
    changeDevice: (device: string) => act(async () => renderer!.update(<Harness device={device} />)),
  };
}

const decoder = new TextDecoder();
function messages(socket: FakeSocket) {
  return socket.sent
    .map((data) => new Uint8Array(data))
    .filter((bytes) => bytes[0] !== 0x0e)
    .map((bytes) => ({ tag: bytes[0], payload: JSON.parse(decoder.decode(bytes.subarray(1))) }));
}
function reply(tag: number, payload: object) {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const bytes = new Uint8Array(1 + json.length);
  bytes[0] = tag;
  bytes.set(json, 1);
  return { data: bytes.buffer };
}
const keyA = { phase: 'down' as const, code: 'KeyA', key: 'a', repeat: false };

test('clipboard capabilities follow the helper flags', async () => {
  for (const [flags, expected] of [
    [{}, false],
    [{ inputPaste: true }, { paste: true, copy: false }],
    [{ inputPaste: true, inputCopy: true }, { paste: true, copy: true }],
  ] as const) {
    const { client } = await renderClient(flags);
    expect(client().capabilities.clipboard).toEqual(expected);
    await act(async () => renderer?.unmount());
    renderer = undefined;
    restoreGlobals();
  }
});

test('an older helper gets no paste or copy request', async () => {
  const { client, admit } = await renderClient({});
  const socket = await admit();
  let failure: unknown;
  await act(async () => { await client().pasteText('text').catch((error) => { failure = error; }); });
  expect(String(failure)).toContain('Paste is not available');
  await act(async () => { await client().copyText().catch((error) => { failure = error; }); });
  expect(String(failure)).toContain('Copy is not available');
  expect(messages(socket)).toEqual([]);
  expect(client().clipboardError).toBe('Copy is not available on this simulator.');
});

test('an unsupported action says it is not available, also when the client has no input queue', async () => {
  // A callback of a replaced config has no input queue, as while input is disconnected.
  const replace = (flags: Flags) => ({
    inputAdmission: true, ...flags, device: 'DEVICE-A', pid: 2, execToken: 'exec-token',
    url: 'http://localhost:3200/sim/helper/DEVICE-A',
    wsUrl: 'ws://localhost:3200/sim/helper/DEVICE-A/ws',
  });
  let failure: unknown;
  const copyOnly = await renderClient({ inputCopy: true });
  const previousCopyOnly = copyOnly.client();
  await copyOnly.pushConfig(replace({ inputCopy: true }));
  await act(async () => { await previousCopyOnly.pasteText('text').catch((error) => { failure = error; }); });
  expect(String(failure)).toContain('Paste is not available');
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  restoreGlobals();

  const pasteOnly = await renderClient({ inputPaste: true });
  const previousPasteOnly = pasteOnly.client();
  await pasteOnly.pushConfig(replace({ inputPaste: true }));
  await act(async () => { await previousPasteOnly.copyText().catch((error) => { failure = error; }); });
  expect(String(failure)).toContain('Copy is not available');
});

test('a paste before admission fails instead of waiting for the socket', async () => {
  const { client, helperSockets } = await renderClient();
  helperSockets()[0]!.readyState = 1;
  let failure: unknown;
  await act(async () => { await client().pasteText('text').catch((error) => { failure = error; }); });
  expect(String(failure)).toContain(INPUT_DISCONNECTED_MESSAGE);
  expect(messages(helperSockets()[0]!)).toEqual([]);
});

test('keys typed after a paste wait for its reply, and a held key is a warning', async () => {
  const { client, admit } = await renderClient();
  const socket = await admit();
  let pasted: Promise<void>;
  await act(async () => {
    pasted = client().pasteText('hello');
    client().sendKey(keyA);
  });
  expect(client().clipboardPending).toBe('paste');
  expect(messages(socket)).toEqual([{ tag: 0x12, payload: { requestId: 1, text: 'hello' } }]);

  await act(async () => socket.onmessage?.(reply(0x92, { requestId: 1, ok: true, cleanupWarning: 'A simulator key may still be held.' })));
  await act(async () => { await pasted; });
  expect(messages(socket).at(-1)).toEqual({ tag: 0x06, payload: { type: 'down', usage: 4 } });
  expect(client().clipboardPending).toBeNull();
  expect(client().clipboardError).toBeNull();
  expect(client().clipboardWarning).toBe('A simulator key may still be held.');
});

test('a failed paste sets clipboardError until the next action starts', async () => {
  const { client, admit } = await renderClient();
  const socket = await admit();
  let failure: unknown;
  await act(async () => {
    const pasted = client().pasteText('hello').catch((error) => { failure = error; });
    socket.onmessage?.(reply(0x92, { requestId: 1, ok: false, error: 'Could not paste into the simulator' }));
    await pasted;
  });
  expect(String(failure)).toContain('Could not paste into the simulator');
  expect(client().clipboardError).toBe('Could not paste into the simulator');
  await act(async () => { void client().pasteText().catch(() => {}); });
  expect(client().clipboardError).toBeNull();
  expect(client().clipboardPending).toBe('paste');
  expect(messages(socket).at(-1)).toEqual({ tag: 0x12, payload: { requestId: 2 } });
});

test('a disconnect fails the pending paste and the keys behind it', async () => {
  const { client, admit, helperSockets } = await renderClient();
  const socket = await admit();
  let failure: unknown;
  await act(async () => {
    void client().pasteText('hello').catch((error) => { failure = error; });
    client().sendKey(keyA);
    socket.onclose?.({ code: 1006, reason: '' });
  });
  expect(String(failure)).toContain(INPUT_DISCONNECTED_MESSAGE);
  expect(client().clipboardError).toBe(INPUT_DISCONNECTED_MESSAGE);
  expect(client().clipboardPending).toBeNull();

  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const retry = await admit(helperSockets().at(-1)!);
  expect(retry).not.toBe(socket);
  await act(async () => retry.onmessage?.(reply(0x92, { requestId: 1, ok: true })));
  expect(messages(retry)).toEqual([]);
});

test('a device change fails the pending request and clears its state', async () => {
  const { client, admit, changeDevice, helperSockets } = await renderClient();
  const socket = await admit();
  let failure: unknown;
  await act(async () => { void client().copyText().catch((error) => { failure = error; }); });
  expect(messages(socket)).toEqual([{ tag: 0x11, payload: { requestId: 1 } }]);
  await changeDevice('DEVICE-B');
  expect(String(failure)).toContain(INPUT_DISCONNECTED_MESSAGE);
  expect(client().clipboardPending).toBeNull();
  expect(client().clipboardError).toBeNull();
  const b = await admit(helperSockets().find((candidate) => candidate.url.includes('DEVICE-B'))!);
  await act(async () => b.onmessage?.(reply(0x91, { requestId: 1, ok: true })));
  expect(messages(b)).toEqual([]);
});

test('a helper replaced during a paste fails the paste instead of reporting success', async () => {
  const { client, admit, pushConfig, helperSockets } = await renderClient();
  const socket = await admit();
  let failure: unknown;
  let pasted = false;
  await act(async () => {
    void client().pasteText('hello').then(() => { pasted = true; }, (error) => { failure = error; });
  });
  expect(client().clipboardPending).toBe('paste');
  // A replacement helper for the same device has a new process, so its input socket is new too.
  await pushConfig({
    inputAdmission: true, inputPaste: true, inputCopy: true, device: 'DEVICE-A', pid: 2, execToken: 'exec-token',
    url: 'http://localhost:3200/sim/helper/DEVICE-A',
    wsUrl: 'ws://localhost:3200/sim/helper/DEVICE-A/ws',
  });
  expect(pasted).toBe(false);
  expect(String(failure)).toContain(INPUT_DISCONNECTED_MESSAGE);
  expect(client().clipboardPending).toBeNull();
  expect(client().clipboardError).toBe(INPUT_DISCONNECTED_MESSAGE);
  // A reply with the old request ID on the replacement's socket does not end the failed paste.
  const replacement = await admit(helperSockets().at(-1)!);
  expect(replacement).not.toBe(socket);
  await act(async () => replacement.onmessage?.(reply(0x92, { requestId: 1, ok: true })));
  expect(pasted).toBe(false);
  expect(client().clipboardError).toBe(INPUT_DISCONNECTED_MESSAGE);
  expect(messages(replacement)).toEqual([]);
});

test('copy reads the pasteboard only after the barrier reply', async () => {
  const { client, admit, copies } = await renderClient();
  const socket = await admit();
  let copied: Promise<string>;
  await act(async () => { copied = client().copyText(); });
  expect(client().clipboardPending).toBe('copy');
  expect(messages(socket)).toEqual([{ tag: 0x11, payload: { requestId: 1 } }]);
  expect(copies).toHaveLength(0);

  await act(async () => socket.onmessage?.(reply(0x91, { requestId: 1, ok: true })));
  let text: string | undefined;
  await act(async () => { text = await copied; });
  expect(text).toBe('copied');
  expect(copies).toHaveLength(1);
  expect(copies[0]!.url).toBe('/sim/api/pasteboard?device=DEVICE-A&copy=1');
  expect(copies[0]!.init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer exec-token' } });
  expect(client().clipboardPending).toBeNull();
});

test('a copy that finds no new text reports a clear error', async () => {
  const { client, admit, copyResponses } = await renderClient();
  const socket = await admit();
  copyResponses.push(Response.json({ ok: false, error: 'timed out' }, { status: 504 }));
  let failure: unknown;
  await act(async () => {
    const copied = client().copyText().catch((error) => { failure = error; });
    socket.onmessage?.(reply(0x91, { requestId: 1, ok: true }));
    await copied;
  });
  expect(String(failure)).toContain('timed out');
  expect(client().clipboardError).toBe('timed out');
  expect(client().clipboardWarning).toBeNull();
});

test('a failed copy shows the key warning of the server', async () => {
  const { client, admit, copyResponses } = await renderClient();
  const socket = await admit();
  copyResponses.push(Response.json(
    { ok: false, error: 'Could not access the simulator pasteboard', cleanupWarning: 'A simulator key may still be held.' },
    { status: 500 },
  ));
  await act(async () => {
    const copied = client().copyText().catch(() => {});
    socket.onmessage?.(reply(0x91, { requestId: 1, ok: true }));
    await copied;
  });
  expect(client().clipboardError).toBe('Could not access the simulator pasteboard');
  expect(client().clipboardWarning).toBe('A simulator key may still be held.');
});

test('each new action changes clipboardActionId, also while the pending action stays the same', async () => {
  const { client, admit } = await renderClient();
  const socket = await admit();
  const start = client().clipboardActionId;
  await act(async () => { void client().pasteText('first').catch(() => {}); });
  expect(client().clipboardActionId).toBe(start + 1);
  await act(async () => { void client().pasteText('second').catch(() => {}); });
  expect(client().clipboardPending).toBe('paste');
  expect(client().clipboardActionId).toBe(start + 2);
  await act(async () => socket.onmessage?.(reply(0x92, { requestId: 1, ok: true })));
  await act(async () => socket.onmessage?.(reply(0x92, { requestId: 2, ok: true })));
  expect(client().clipboardPending).toBeNull();
  expect(client().clipboardActionId).toBe(start + 2);
});

test('the latest action owns the clipboard state', async () => {
  const { client, admit } = await renderClient();
  const socket = await admit();
  let first: Promise<unknown>;
  let copied: Promise<string>;
  await act(async () => {
    first = client().pasteText('first').catch((error) => error);
    copied = client().copyText();
  });
  expect(client().clipboardPending).toBe('copy');
  await act(async () => socket.onmessage?.(reply(0x92, { requestId: 1, ok: false, error: 'Could not paste into the simulator' })));
  let failure: unknown;
  await act(async () => { failure = await first; });
  expect(String(failure)).toContain('Could not paste into the simulator');
  expect(client().clipboardPending).toBe('copy');
  expect(client().clipboardError).toBeNull();
  expect(messages(socket).at(-1)).toEqual({ tag: 0x11, payload: { requestId: 2 } });
  await act(async () => socket.onmessage?.(reply(0x91, { requestId: 2, ok: true })));
  let text: string | undefined;
  await act(async () => { text = await copied; });
  expect(text).toBe('copied');
  expect(client().clipboardPending).toBeNull();
});

test('focus loss keeps a release that waits behind a paste', async () => {
  const { client, admit, dispatch } = await renderClient();
  const socket = await admit();
  await act(async () => {
    void client().pasteText('hello').catch(() => {});
    client().sendKey({ ...keyA, phase: 'up' });
    client().sendKey(keyA);
    dispatch('blur');
  });
  await act(async () => socket.onmessage?.(reply(0x92, { requestId: 1, ok: true })));
  expect(messages(socket).slice(1)).toEqual([{ tag: 0x06, payload: { type: 'up', usage: 4 } }]);
});
