import { afterEach, describe, expect, test } from 'bun:test';

import { endpointFor, startIosHelper } from '../connections';

/** Stub just enough of `window` for endpointFor. */
function stubWindow() {
  (globalThis as any).window = {
    location: { origin: 'http://localhost:8081' },
  };
}

const realFetch = globalThis.fetch;

afterEach(() => {
  delete (globalThis as any).window;
  globalThis.fetch = realFetch;
});

describe('startIosHelper', () => {
  test('posts the udid to the grid, with the access token as a bearer when given', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(null);
    }) as typeof fetch;

    await startIosHelper('UDID', 'http://hub.test/vendor/serve-sim/', 'secret');
    await startIosHelper('UDID', 'http://hub.test/vendor/serve-sim');

    expect(calls.map((c) => c.url)).toEqual([
      'http://hub.test/vendor/serve-sim/grid/api/start',
      'http://hub.test/vendor/serve-sim/grid/api/start',
    ]);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ udid: 'UDID' });
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer secret');
    expect(new Headers(calls[1]!.init?.headers).get('authorization')).toBeNull();
  });
});

describe('endpointFor', () => {
  test('derives vendor mounts from the given base path', () => {
    stubWindow();
    expect(endpointFor('ios', '/_expo/plugins/expo-device-hub')).toBe(
      'http://localhost:8081/_expo/plugins/expo-device-hub/vendor/serve-sim',
    );
    expect(endpointFor('android', '/_expo/plugins/expo-device-hub')).toBe(
      'http://localhost:8081/_expo/plugins/expo-device-hub/vendor/serve-emu',
    );
  });

  test("'' and '/' both mean an origin-root mount, trailing slashes are trimmed", () => {
    stubWindow();
    expect(endpointFor('ios', '')).toBe('http://localhost:8081/vendor/serve-sim');
    expect(endpointFor('ios', '/')).toBe('http://localhost:8081/vendor/serve-sim');
    expect(endpointFor('android', '/hub/')).toBe('http://localhost:8081/hub/vendor/serve-emu');
  });

  test('stays a bare path without a window (SSR)', () => {
    expect(endpointFor('ios', '/hub')).toBe('/hub/vendor/serve-sim');
  });
});
