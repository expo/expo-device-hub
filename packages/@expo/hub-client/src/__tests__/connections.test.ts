import { afterEach, describe, expect, test } from 'bun:test';

import { endpointFor } from '../connections';

/** Stub just enough of `window` for endpointFor. */
function stubWindow() {
  (globalThis as any).window = {
    location: { origin: 'http://localhost:8081' },
  };
}

afterEach(() => {
  delete (globalThis as any).window;
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
