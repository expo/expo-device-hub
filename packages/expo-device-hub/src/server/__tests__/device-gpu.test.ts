import { expect, test } from 'bun:test';
import { handleDeviceGpuRequest } from '../device-gpu';

test('returns runtime metadata for the requested serial without caching', async () => {
  const gpu = { name: 'SwiftShader', renderer: 'Google SwiftShader', description: 'Software' };
  const request = new Request('http://localhost/api/devices/gpu?serial=emulator-5556');
  const response = await handleDeviceGpuRequest(request, async (serial, options) => {
    expect(serial).toBe('emulator-5556');
    expect(options?.signal).toBe(request.signal);
    return { value: gpu, error: null };
  });
  expect(await response.json()).toEqual({ gpu });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});

test('returns null on a failed GPU read', async () => {
  const response = await handleDeviceGpuRequest(
    new Request('http://localhost/api/devices/gpu?serial=emulator-5554'),
    async () => ({ value: null, error: { message: 'Timed out', error: new Error('timeout') } }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ gpu: null });
});

test.each([
  ['GET', '', 400],
  ['GET', '?serial=physical-device', 400],
  ['POST', '?serial=emulator-5554', 405],
])('rejects %s %s before invoking adb', async (method, query, status) => {
  const response = await handleDeviceGpuRequest(
    new Request(`http://localhost/api/devices/gpu${query}`, { method }),
    async () => { throw new Error('Must not read GPU'); },
  );
  expect(response.status).toBe(status);
});
