import { describe, expect, test } from 'bun:test';

import { handleEasEndpoint } from '../eas-endpoints';

const options = {
  mountPath: '/_expo/plugins/expo-device-hub',
  serveSimPrefix: '/vendor/serve-sim',
};

describe('EAS endpoints', () => {
  test('always reports ready with the interface placeholder device ID', async () => {
    const response = await handleEasEndpoint(new Request('http://localhost/readyz'), options);

    expect(response?.status).toBe(200);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(await response?.json()).toEqual({ status: 'ready', device: 'no-device-id' });
  });

  test('redirects metrics to the mounted serve-sim endpoint', async () => {
    const response = await handleEasEndpoint(
      new Request('http://localhost/metrics?device=simulator-id'),
      options
    );

    expect(response?.status).toBe(307);
    expect(response?.headers.get('location')).toBe(
      '/_expo/plugins/expo-device-hub/vendor/serve-sim/metrics?device=simulator-id'
    );
  });

  const stopRequest = (token?: string, method = 'POST') =>
    new Request('http://localhost/_eas/android-recording/stop', {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  test('closes the recording stop route without a matching token', async () => {
    const finishAndroidRecording = async () => ({ recorded: true }) as const;
    expect((await handleEasEndpoint(stopRequest('secret'), options))?.status).toBe(401);
    const wrong = await handleEasEndpoint(stopRequest('wrong'), {
      ...options,
      recordingControlToken: 'secret',
      finishAndroidRecording,
    });
    expect(wrong?.status).toBe(401);
    const get = await handleEasEndpoint(stopRequest('secret', 'GET'), {
      ...options,
      recordingControlToken: 'secret',
      finishAndroidRecording,
    });
    expect(get?.status).toBe(405);
  });

  test('reports whether the stop request published a recording', async () => {
    const stopped = await handleEasEndpoint(stopRequest('secret'), {
      ...options,
      recordingControlToken: 'secret',
      finishAndroidRecording: async () => ({ recorded: true }),
    });
    expect(stopped?.status).toBe(200);
    expect(await stopped?.json()).toEqual({ ok: true });
    const skipped = await handleEasEndpoint(stopRequest('secret'), {
      ...options,
      recordingControlToken: 'secret',
      finishAndroidRecording: async () => ({ recorded: false, reason: 'found 0 emulators' }),
    });
    expect(skipped?.status).toBe(409);
    expect(await skipped?.json()).toEqual({ ok: false, error: 'found 0 emulators' });
    const failed = await handleEasEndpoint(stopRequest('secret'), {
      ...options,
      recordingControlToken: 'secret',
      finishAndroidRecording: async () => {
        throw new Error('mux failure');
      },
    });
    expect(failed?.status).toBe(500);
  });

  test('leaves unrelated routes unhandled', () => {
    expect(handleEasEndpoint(new Request('http://localhost/other'), options)).toBeNull();
  });
});
