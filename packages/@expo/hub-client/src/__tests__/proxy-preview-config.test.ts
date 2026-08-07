import { describe, expect, test } from 'bun:test';

import { proxyPreviewConfigForBrowser } from '../proxy-preview-config';

const baseConfig = {
  pid: 101,
  port: 3100,
  device: 'DEVICE-A',
  url: 'https://tunnel.example.test:0/vendor/serve-sim/helper/DEVICE-A',
  streamUrl: 'https://tunnel.example.test:0/vendor/serve-sim/helper/DEVICE-A/stream.mjpeg',
  wsUrl: 'wss://tunnel.example.test:0/vendor/serve-sim/helper/DEVICE-A/ws',
  basePath: '/vendor/serve-sim',
  execToken: 'token',
  proxyHelpers: true as const,
};

describe('proxyPreviewConfigForBrowser', () => {
  test('replaces an internal port 0 with the browser origin', () => {
    expect(
      proxyPreviewConfigForBrowser(baseConfig, {
        protocol: 'https:',
        host: 'tunnel.example.test',
      }),
    ).toEqual({
      ...baseConfig,
      url: 'https://tunnel.example.test/vendor/serve-sim/helper/DEVICE-A',
      streamUrl: 'https://tunnel.example.test/vendor/serve-sim/helper/DEVICE-A/stream.mjpeg',
      wsUrl: 'wss://tunnel.example.test/vendor/serve-sim/helper/DEVICE-A/ws',
    });
  });

  test('preserves explicit browser ports and middleware mount paths', () => {
    expect(
      proxyPreviewConfigForBrowser(
        { ...baseConfig, basePath: '/_expo/plugins/expo-device-hub/vendor/serve-sim' },
        { protocol: 'http:', host: 'localhost:8081' },
      ),
    ).toEqual({
      ...baseConfig,
      basePath: '/_expo/plugins/expo-device-hub/vendor/serve-sim',
      url: 'http://localhost:8081/_expo/plugins/expo-device-hub/vendor/serve-sim/helper/DEVICE-A',
      streamUrl:
        'http://localhost:8081/_expo/plugins/expo-device-hub/vendor/serve-sim/helper/DEVICE-A/stream.mjpeg',
      wsUrl:
        'ws://localhost:8081/_expo/plugins/expo-device-hub/vendor/serve-sim/helper/DEVICE-A/ws',
    });
  });

  test("leaves direct helper configs untouched when proxying isn't enabled", () => {
    const direct = { ...baseConfig, proxyHelpers: undefined };
    expect(
      proxyPreviewConfigForBrowser(direct, {
        protocol: 'https:',
        host: 'tunnel.example.test',
      }),
    ).toBe(direct);
  });
});
