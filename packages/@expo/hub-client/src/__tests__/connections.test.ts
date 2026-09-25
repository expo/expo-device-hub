import { afterEach, describe, expect, test } from 'bun:test';

import { endpointFor, startIosHelper } from '../connections';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();

/** Stub just enough of `window` for endpointFor. */
function stubWindow() {
  (globalThis as any).window = {
    location: { origin: 'http://localhost:8081' },
  };
}

afterEach(() => {
  delete (globalThis as any).window;
  restoreGlobals();
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

  test('derives vendor mounts on a remote Hub instead of the page origin', () => {
    stubWindow();
    expect(endpointFor('ios', 'https://hub.example.test/device-hub/')).toBe(
      'https://hub.example.test/device-hub/vendor/serve-sim',
    );
    expect(endpointFor('android', 'https://hub.example.test/device-hub/')).toBe(
      'https://hub.example.test/device-hub/vendor/serve-emu',
    );
  });

  test('stays a bare path without a window (SSR)', () => {
    expect(endpointFor('ios', '/hub')).toBe('/hub/vendor/serve-sim');
  });
});

test('starts the selected simulator through the remote public mount', async () => {
  const requests: string[] = [];
  stubGlobal('fetch', async (url: string) => {
    requests.push(String(url));
    return Response.json({});
  });
  await startIosHelper('DEVICE-A', 'https://hub.example.test/device-hub/vendor/serve-sim');
  expect(requests).toEqual([
    'https://hub.example.test/device-hub/vendor/serve-sim/grid/api/start',
  ]);
});
