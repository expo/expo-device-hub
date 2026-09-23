import { afterEach, expect, test } from 'bun:test';

import { bootDevice, createDevice, removeDevice, shutdownDevice } from '../deviceActions';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test('all dashboard lifecycle actions send the provided access token as a bearer', async () => {
  Object.defineProperty(globalThis, 'window', {
    value: { __EXPO_DEVICE_HUB_BASE_PATH__: '/hub' }, configurable: true,
  });
  const requests: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') });
    return Response.json({ ok: true, id: 'device' });
  }) as typeof fetch;
  const device = {
    id: 'device', name: 'Test phone', platform: 'ios' as const,
    version: '18.0', booted: false, physical: false, supported: true, deviceFrame: null,
  };
  for (const token of ['session', null]) {
    await bootDevice(device, token);
    await shutdownDevice(device, token);
    await removeDevice(device, token);
    await createDevice({ ...device, runtime: 'runtime', deviceType: 'phone' }, token);
  }
  expect(requests).toEqual(
    ['Bearer session', null].flatMap((authorization) =>
      ['boot', 'shutdown', 'remove', 'create'].map((action) => ({
        url: `/hub/api/devices/${action}`, authorization,
      })),
    ),
  );
});
