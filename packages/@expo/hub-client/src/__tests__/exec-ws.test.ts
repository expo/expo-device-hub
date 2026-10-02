import { afterEach, describe, expect, test } from 'bun:test';

import { hostUiRequest, runHostAction } from '../exec-ws.js';

/**
 * Minimal scripted WebSocket: records frames the client sends and lets the
 * test answer them. Installed on `globalThis` for the duration of a test.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  reply(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const realWebSocket = globalThis.WebSocket;

function installFakeWebSocket() {
  FakeWebSocket.instances = [];
  (globalThis as any).WebSocket = FakeWebSocket;
}

afterEach(() => {
  (globalThis as any).WebSocket = realWebSocket;
});

/** Drive the auth handshake: expect `{token}` first, answer `{ready}`, return the request frame. */
async function handshake(token: string): Promise<{ ws: FakeWebSocket; request: any }> {
  await new Promise((r) => setTimeout(r, 0));
  const ws = FakeWebSocket.instances[0]!;
  expect(JSON.parse(ws.sent[0]!)).toEqual({ token });
  ws.reply({ ready: true });
  return { ws, request: JSON.parse(ws.sent[1]!) };
}

describe('runHostAction', () => {
  test('authenticates, sends a typed action frame, and resolves the result', async () => {
    installFakeWebSocket();
    const pending = runHostAction('ws://hub/exec-ws', 'secret', 'app.container', {
      udid: 'UDID',
      bundleId: 'com.example.app',
    });
    const { ws, request } = await handshake('secret');
    // `{id, action, params}` — serve-sim's action protocol, never `{command}`.
    expect(request).toEqual({
      id: 1,
      action: 'app.container',
      params: { udid: 'UDID', bundleId: 'com.example.app' },
    });
    ws.reply({ id: 1, stdout: '/path/Foo.app\n', stderr: '', exitCode: 0 });
    expect(await pending).toEqual({ stdout: '/path/Foo.app\n', stderr: '', exitCode: 0 });
    expect(ws.closed).toBe(true);
  });

  test('maps a rejected action to a failed result instead of throwing', async () => {
    installFakeWebSocket();
    const pending = runHostAction('ws://hub/exec-ws', 'secret', 'app.container', { udid: '-x' });
    const { ws } = await handshake('secret');
    ws.reply({ id: 1, error: 'app.container: udid must be a simulator udid or device name' });
    expect(await pending).toEqual({
      stdout: '',
      stderr: 'app.container: udid must be a simulator udid or device name',
      exitCode: 1,
    });
  });

  test('rejects when the socket closes before answering', async () => {
    installFakeWebSocket();
    const pending = runHostAction('ws://hub/exec-ws', 'secret', 'app.container', { udid: 'U' });
    const { ws } = await handshake('secret');
    ws.onclose?.();
    await expect(pending).rejects.toThrow('exec-ws closed');
  });
});

describe('hostUiRequest', () => {
  test('reads the simulator settings status', async () => {
    installFakeWebSocket();
    const pending = hostUiRequest('ws://hub/exec-ws', 'secret', { device: 'UDID' });
    const { ws, request } = await handshake('secret');
    expect(request).toEqual({ id: 1, ui: { device: 'UDID' } });
    ws.reply({ id: 1, status: { appearance: 'dark', 'hardware-keyboard': 'off' } });
    expect(await pending).toEqual({
      status: { appearance: 'dark', 'hardware-keyboard': 'off' },
    });
  });

  test('rejects with the server message when a write is refused', async () => {
    installFakeWebSocket();
    const pending = hostUiRequest('ws://hub/exec-ws', 'secret', {
      device: 'UDID',
      option: 'hardware-keyboard',
      value: 'sideways',
    });
    const { ws } = await handshake('secret');
    ws.reply({ id: 1, error: 'invalid value for hardware-keyboard: sideways' });
    await expect(pending).rejects.toThrow('invalid value for hardware-keyboard: sideways');
  });
});
