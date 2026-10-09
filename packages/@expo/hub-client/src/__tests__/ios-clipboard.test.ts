import { expect, test } from 'bun:test';

import { copySimulatorText } from '../ios-clipboard';

function respond(status: number, body: object | null) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return body === null ? new Response('gateway', { status }) : Response.json(body, { status });
  };
  return { requests, fetchImpl };
}

test('copy posts to the pasteboard route with the exec token as a bearer', async () => {
  const { requests, fetchImpl } = respond(200, { ok: true, text: 'copied' });
  const signal = new AbortController().signal;
  expect(await copySimulatorText('/hub/sim/', 'UDID 1', 'exec-token', fetchImpl, signal)).toEqual({
    text: 'copied',
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe('/hub/sim/api/pasteboard?device=UDID%201&copy=1');
  expect(requests[0]!.init).toMatchObject({
    method: 'POST',
    cache: 'no-store',
    signal,
    headers: { Authorization: 'Bearer exec-token' },
  });
});

test('copy keeps an empty result and reports a held key as a warning', async () => {
  const { fetchImpl } = respond(200, { ok: true, text: '', cleanupWarning: 'A key may still be held.' });
  expect(await copySimulatorText('/sim', null, null, fetchImpl)).toEqual({
    text: '',
    cleanupWarning: 'A key may still be held.',
  });
});

test('copy sends no Authorization header of its own without an exec token', async () => {
  const { requests, fetchImpl } = respond(200, { ok: true, text: 'x' });
  await copySimulatorText('/sim', null, null, fetchImpl);
  expect(requests[0]!.url).toBe('/sim/api/pasteboard?copy=1');
  expect(requests[0]!.init?.headers).toBeUndefined();
});

for (const [status, message] of [
  [504, 'The app did not copy any new text. Select text in the app and try again.'],
  [409, 'The simulator has no input connection. Reconnect and try again.'],
  [413, 'The copied text is larger than 4 MiB.'],
] as const) {
  test(`copy shows the server error for ${status}, and a clear message without one`, async () => {
    await expect(
      copySimulatorText('/sim', 'udid', 'token', respond(status, { ok: false, error: 'server text' }).fetchImpl),
    ).rejects.toThrow('server text');
    await expect(
      copySimulatorText('/sim', 'udid', 'token', respond(status, { ok: false }).fetchImpl),
    ).rejects.toThrow(message);
  });
}

test('a failed copy keeps the key warning of the server', async () => {
  const { fetchImpl } = respond(503, {
    ok: false,
    error: 'The simulator pasteboard is not available',
    cleanupWarning: 'A key may still be held.',
  });
  const failure = await copySimulatorText('/sim', 'udid', 'token', fetchImpl).then(() => null, (error: unknown) => error);
  expect(failure).toMatchObject({
    message: 'The simulator pasteboard is not available',
    cleanupWarning: 'A key may still be held.',
  });
});

test('copy shows the server error for other failures', async () => {
  await expect(
    copySimulatorText('/sim', 'udid', 'token', respond(403, { ok: false, error: 'This origin cannot use the simulator clipboard' }).fetchImpl),
  ).rejects.toThrow('This origin cannot use the simulator clipboard');
  await expect(copySimulatorText('/sim', 'udid', 'token', respond(502, null).fetchImpl)).rejects.toThrow(
    'Could not copy from the simulator (502).',
  );
});

test('copy reports an unreachable server', async () => {
  const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
  await expect(copySimulatorText('/sim', 'udid', 'token', fetchImpl)).rejects.toThrow(
    'Could not reach the simulator to copy.',
  );
});
