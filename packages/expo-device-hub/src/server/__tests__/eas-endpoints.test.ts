import { describe, expect, test } from 'bun:test';

import { handleEasEndpoint } from '../eas-endpoints';

const options = {
  mountPath: '/_expo/plugins/expo-device-hub',
  serveSimPrefix: '/vendor/serve-sim',
};

describe('EAS endpoints', () => {
  test('always reports ready with the interface placeholder device ID', async () => {
    const response = handleEasEndpoint(new Request('http://localhost/readyz'), options);

    expect(response?.status).toBe(200);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(await response?.json()).toEqual({ status: 'ready', device: 'no-device-id' });
  });

  test('redirects metrics to the mounted serve-sim endpoint', () => {
    const response = handleEasEndpoint(
      new Request('http://localhost/metrics?device=simulator-id'),
      options
    );

    expect(response?.status).toBe(307);
    expect(response?.headers.get('location')).toBe(
      '/_expo/plugins/expo-device-hub/vendor/serve-sim/metrics?device=simulator-id'
    );
  });

  test('leaves unrelated routes unhandled', () => {
    expect(handleEasEndpoint(new Request('http://localhost/other'), options)).toBeNull();
  });
});
