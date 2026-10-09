import { expect, test } from 'bun:test';

import { createOrderedKeyboardInput, INPUT_DISCONNECTED_MESSAGE } from '../ordered-keyboard-input';

const decoder = new TextDecoder();

function frame(tag: number, payload: object): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const bytes = new Uint8Array(1 + json.length);
  bytes[0] = tag;
  bytes.set(json, 1);
  return bytes.buffer;
}

function setup({ admitted = true, replyTimeoutMs }: { admitted?: boolean; replyTimeoutMs?: number } = {}) {
  const wire: Array<{ tag: number; payload: Record<string, unknown> }> = [];
  const state = { admitted };
  const input = createOrderedKeyboardInput({
    sendKey: (message) => wire.push({ tag: 0x06, payload: message }),
    trySendFrame: (bytes) => {
      if (!state.admitted) return false;
      wire.push({ tag: bytes[0]!, payload: JSON.parse(decoder.decode(bytes.subarray(1))) });
      return true;
    },
    replyTimeoutMs,
    keyPaceMs: 0,
  });
  return { input, wire, state };
}

const key = (type: 'down' | 'up', usage: number) => ({ type, usage });
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

test('a paste sends its text with a request ID, and a paste without text sends none', () => {
  const { input, wire } = setup();
  void input.paste('héllo');
  expect(wire).toEqual([{ tag: 0x12, payload: { requestId: 1, text: 'héllo' } }]);
  input.receive(frame(0x92, { requestId: 1, ok: true }));
  void input.paste();
  expect(wire[1]).toEqual({ tag: 0x12, payload: { requestId: 2 } });
});

test('keys typed after a paste wait for the reply with its request ID', async () => {
  const { input, wire } = setup();
  input.send(key('down', 4));
  const pasted = input.paste('text');
  input.send(key('up', 4));
  input.send(key('down', 5));
  expect(wire.map((entry) => entry.tag)).toEqual([0x06, 0x12]);

  expect(input.receive(frame(0x92, { requestId: 99, ok: true }))).toBe(true);
  expect(input.receive(frame(0x91, { requestId: 1, ok: true }))).toBe(true);
  expect(wire).toHaveLength(2);

  input.receive(frame(0x92, { requestId: 1, ok: true, cleanupWarning: 'A simulator key may still be held.' }));
  expect(await pasted).toEqual({ cleanupWarning: 'A simulator key may still be held.' });
  expect(wire.slice(2)).toEqual([
    { tag: 0x06, payload: key('up', 4) },
    { tag: 0x06, payload: key('down', 5) },
  ]);
});

test('other frames are left to the socket', () => {
  const { input } = setup();
  expect(input.receive(Uint8Array.of(0x83).buffer)).toBe(false);
  expect(input.receive(frame(0x82, { width: 1, height: 1 }))).toBe(false);
});

test('a failed paste rejects with the server error and releases the keys behind it', async () => {
  const { input, wire } = setup();
  const pasted = input.paste('text');
  input.send(key('down', 4));
  input.receive(frame(0x92, { requestId: 1, ok: false, error: 'Could not paste into the simulator' }));
  await expect(pasted).rejects.toThrow('Could not paste into the simulator');
  expect(wire.at(-1)).toEqual({ tag: 0x06, payload: key('down', 4) });
});

test('a failed paste keeps a key warning that its reply carries', async () => {
  const { input } = setup();
  const pasted = input.paste('text');
  input.receive(frame(0x92, { requestId: 1, ok: false, error: 'Paste failed', cleanupWarning: 'A simulator key may still be held.' }));
  const failure = await pasted.then(() => null, (error: unknown) => error);
  expect(failure).toMatchObject({ message: 'Paste failed', cleanupWarning: 'A simulator key may still be held.' });
});

test('requests are sent only on an admitted socket', async () => {
  const { input, wire } = setup({ admitted: false });
  await expect(input.paste('text')).rejects.toThrow(INPUT_DISCONNECTED_MESSAGE);
  await expect(input.readAfterInput(async () => 'never')).rejects.toThrow(INPUT_DISCONNECTED_MESSAGE);
  input.send(key('down', 4));
  expect(wire).toEqual([{ tag: 0x06, payload: key('down', 4) }]);
});

test('text over the input frame limit is refused before it is sent', async () => {
  const { input, wire } = setup();
  await expect(input.paste('x'.repeat(4 * 1024 * 1024))).rejects.toThrow('too large');
  expect(wire).toEqual([]);
});

test('a disconnect fails every request without a reply and drops the keys behind them', async () => {
  const { input, wire } = setup();
  const pasted = input.paste('text');
  input.send(key('down', 4));
  let read = false;
  const copied = input.readAfterInput(async () => { read = true; return 'copied'; });
  input.cancel();
  await expect(pasted).rejects.toThrow(INPUT_DISCONNECTED_MESSAGE);
  await expect(copied).rejects.toThrow(INPUT_DISCONNECTED_MESSAGE);
  input.receive(frame(0x92, { requestId: 1, ok: true }));
  expect(read).toBe(false);
  expect(wire.map((entry) => entry.tag)).toEqual([0x12]);

  // The next connection starts with an empty queue.
  input.send(key('down', 5));
  expect(wire.at(-1)).toEqual({ tag: 0x06, payload: key('down', 5) });
});

test('copy reads only after its barrier, and keys typed meanwhile wait for the read', async () => {
  const { input, wire } = setup();
  const pasted = input.paste('text');
  let finishRead!: (text: string) => void;
  let readStarted = false;
  const copied = input.readAfterInput(() => {
    readStarted = true;
    return new Promise<string>((resolve) => { finishRead = resolve; });
  });
  input.send(key('down', 4));
  expect(wire.map((entry) => entry.tag)).toEqual([0x12]);

  input.receive(frame(0x92, { requestId: 1, ok: true }));
  await pasted;
  expect(wire.at(-1)).toEqual({ tag: 0x11, payload: { requestId: 2 } });
  expect(readStarted).toBe(false);

  input.receive(frame(0x91, { requestId: 2, ok: true }));
  input.receive(frame(0x91, { requestId: 2, ok: true }));
  await flush();
  expect(readStarted).toBe(true);
  expect(wire.at(-1)!.tag).toBe(0x11);

  finishRead('copied');
  expect(await copied).toBe('copied');
  expect(wire.at(-1)).toEqual({ tag: 0x06, payload: key('down', 4) });
});

test('a failed barrier rejects the copy without reading', async () => {
  const { input } = setup();
  let read = false;
  const copied = input.readAfterInput(async () => { read = true; return ''; });
  input.receive(frame(0x91, { requestId: 1, ok: false }));
  await expect(copied).rejects.toThrow('Simulator input failed');
  expect(read).toBe(false);
});

test('focus loss drops presses behind a paste but keeps their releases', async () => {
  const { input, wire } = setup();
  const pasted = input.paste('text');
  input.send(key('up', 0xe3));
  input.send(key('down', 4));
  input.enqueue([key('down', 5), key('up', 5)]);
  const released: unknown[] = [];
  input.cancelKeys((event) => released.push(event));
  expect(released).toEqual([]);

  input.receive(frame(0x92, { requestId: 1, ok: true }));
  await pasted;
  await flush();
  expect(wire.slice(1)).toEqual([{ tag: 0x06, payload: key('up', 0xe3) }]);
});

test('focus loss releases the keys that a paced burst holds, then sends the next request', async () => {
  const wire: Array<{ tag: number; payload: unknown }> = [];
  const input = createOrderedKeyboardInput({
    sendKey: (message) => wire.push({ tag: 0x06, payload: message }),
    trySendFrame: (bytes) => { wire.push({ tag: bytes[0]!, payload: null }); return true; },
    keyPaceMs: 1_000,
  });
  input.enqueue([key('down', 0xe1), key('down', 4), key('up', 4), key('up', 0xe1)]);
  void input.paste('text').catch(() => {});
  expect(wire).toEqual([{ tag: 0x06, payload: key('down', 0xe1) }]);
  const released: unknown[] = [];
  input.cancelKeys((event) => released.push(event));
  expect(released).toEqual([key('up', 0xe1)]);
  expect(wire.at(-1)!.tag).toBe(0x12);
  input.dispose();
});

test('a paste waits for an earlier paced burst to finish', async () => {
  const { input, wire } = setup();
  input.enqueue([key('down', 4), key('up', 4), key('down', 5), key('up', 5)]);
  void input.paste('text');
  expect(wire.map((entry) => entry.tag)).toEqual([0x06]);
  await flush();
  expect(wire.map((entry) => entry.tag)).toEqual([0x06, 0x06, 0x06, 0x06, 0x12]);
});

test('a request without a reply times out and lets later keys through', async () => {
  const { input, wire } = setup({ replyTimeoutMs: 5 });
  const pasted = input.paste('text');
  input.send(key('down', 4));
  await expect(pasted).rejects.toThrow('Paste timed out.');
  expect(wire.at(-1)).toEqual({ tag: 0x06, payload: key('down', 4) });
});
