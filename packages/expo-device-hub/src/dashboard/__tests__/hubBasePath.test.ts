import { afterEach, describe, expect, test } from 'bun:test';

import { basePath } from '../basePath';

const PLUGIN_MOUNT = '/_expo/plugins/expo-device-hub';

function stubWindow(options: { dev?: boolean; basePath?: string } = {}) {
  (globalThis as any).window = {
    __DEV__: options.dev,
    __EXPO_DEVICE_HUB_BASE_PATH__: options.basePath,
  };
}

afterEach(() => {
  delete (globalThis as any).window;
});

describe('basePath', () => {
  test('uses the local plugin mount in dev', () => {
    stubWindow({ dev: true });
    expect(basePath()).toBe(PLUGIN_MOUNT);
  });

  test('throws when the shell set nothing', () => {
    stubWindow();
    expect(() => basePath()).toThrow('window.__EXPO_DEVICE_HUB_BASE_PATH__ is not defined');
  });

  test('uses the mount the shell declared, trimming trailing slashes', () => {
    stubWindow({ basePath: PLUGIN_MOUNT });
    expect(basePath()).toBe(PLUGIN_MOUNT);

    stubWindow({ basePath: '/hub/' });
    expect(basePath()).toBe('/hub');
  });

  test("'' and '/' both mean an origin-root mount", () => {
    stubWindow({ basePath: '' });
    expect(basePath()).toBe('');

    stubWindow({ basePath: '/' });
    expect(basePath()).toBe('');
  });
});
