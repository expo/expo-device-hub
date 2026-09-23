import { describe, expect, test } from 'bun:test';

import { middlewareEndpointForBrowser, proxyPreviewConfigForBrowser } from '../proxy-preview-config';

const baseConfig = {
  pid: 101,
  port: 3100,
  device: 'DEVICE-A',
  url: 'https://tunnel.example.test:0/vendor/serve-sim/helper/DEVICE-A',
  streamUrl: 'https://tunnel.example.test:0/vendor/serve-sim/helper/DEVICE-A/stream.mjpeg',
  wsUrl: 'wss://tunnel.example.test:0/vendor/serve-sim/helper/DEVICE-A/ws',
  streamSettingsEndpoint: 'http://127.0.0.1:49152/stream-settings',
  basePath: '/vendor/serve-sim',
  execToken: 'token',
  proxyHelpers: true as const,
};

describe('proxyPreviewConfigForBrowser', () => {
  test('replaces an internal port 0 with the configured middleware URL', () => {
    expect(
      proxyPreviewConfigForBrowser(baseConfig, new URL('https://tunnel.example.test/vendor/serve-sim')),
    ).toEqual({
      ...baseConfig,
      url: 'https://tunnel.example.test/vendor/serve-sim/helper/DEVICE-A',
      streamUrl: 'https://tunnel.example.test/vendor/serve-sim/helper/DEVICE-A/stream.mjpeg',
      wsUrl: 'wss://tunnel.example.test/vendor/serve-sim/helper/DEVICE-A/ws',
      streamSettingsEndpoint:
        'https://tunnel.example.test/vendor/serve-sim/helper/DEVICE-A/stream-settings',
    });
  });

  test('preserves explicit ports and middleware mount paths', () => {
    expect(
      proxyPreviewConfigForBrowser(
        { ...baseConfig, basePath: '/_expo/plugins/expo-device-hub/vendor/serve-sim' },
        new URL('http://localhost:8081/_expo/plugins/expo-device-hub/vendor/serve-sim'),
      ),
    ).toEqual({
      ...baseConfig,
      basePath: '/_expo/plugins/expo-device-hub/vendor/serve-sim',
      url: 'http://localhost:8081/_expo/plugins/expo-device-hub/vendor/serve-sim/helper/DEVICE-A',
      streamUrl:
        'http://localhost:8081/_expo/plugins/expo-device-hub/vendor/serve-sim/helper/DEVICE-A/stream.mjpeg',
      wsUrl:
        'ws://localhost:8081/_expo/plugins/expo-device-hub/vendor/serve-sim/helper/DEVICE-A/ws',
      streamSettingsEndpoint:
        'http://localhost:8081/_expo/plugins/expo-device-hub/vendor/serve-sim/helper/DEVICE-A/stream-settings',
    });
  });

  test('uses the remote public mount even when the config advertises a different base path', () => {
    expect(
      proxyPreviewConfigForBrowser(
        { ...baseConfig, device: 'DEVICE A/B', basePath: '/internal/serve-sim' },
        new URL('https://stream.example.test:8443/preview/session/'),
      ),
    ).toEqual({
      ...baseConfig,
      device: 'DEVICE A/B',
      basePath: '/internal/serve-sim',
      url: 'https://stream.example.test:8443/preview/session/helper/DEVICE%20A%2FB',
      streamUrl: 'https://stream.example.test:8443/preview/session/helper/DEVICE%20A%2FB/stream.mjpeg',
      wsUrl: 'wss://stream.example.test:8443/preview/session/helper/DEVICE%20A%2FB/ws',
      streamSettingsEndpoint:
        'https://stream.example.test:8443/preview/session/helper/DEVICE%20A%2FB/stream-settings',
    });
  });

  test('handles a remote root mount', () => {
    const result = proxyPreviewConfigForBrowser(
      baseConfig,
      new URL('https://stream.example.test/'),
    );
    expect(result.url).toBe('https://stream.example.test/helper/DEVICE-A');
    expect(result.wsUrl).toBe('wss://stream.example.test/helper/DEVICE-A/ws');
  });

  test("leaves direct helper configs untouched when proxying isn't enabled", () => {
    const direct = { ...baseConfig, proxyHelpers: undefined };
    expect(
      proxyPreviewConfigForBrowser(direct, new URL('https://tunnel.example.test')),
    ).toBe(direct);
  });
});

describe('middlewareEndpointForBrowser', () => {
  const publicMount = new URL('https://stream.example.test:8443/preview/session/');

  test('maps advertised middleware routes onto the public mount and keeps their query', () => {
    expect(
      middlewareEndpointForBrowser('/internal/logs?device=DEVICE%20A', publicMount, '/internal'),
    ).toBe('https://stream.example.test:8443/preview/session/logs?device=DEVICE%20A');
    expect(
      middlewareEndpointForBrowser('http://127.0.0.1:3200/internal/ax?device=DEVICE-A', publicMount, '/internal'),
    ).toBe('https://stream.example.test:8443/preview/session/ax?device=DEVICE-A');
  });

  test('maps routes from a root-mounted backend without duplicating the public prefix', () => {
    expect(middlewareEndpointForBrowser('/grid/api', publicMount, '')).toBe(
      'https://stream.example.test:8443/preview/session/grid/api',
    );
    expect(middlewareEndpointForBrowser('appstate?device=DEVICE-A', publicMount, '')).toBe(
      'https://stream.example.test:8443/preview/session/appstate?device=DEVICE-A',
    );
    expect(middlewareEndpointForBrowser('/preview/session/grid/api', publicMount, '')).toBe(
      'https://stream.example.test:8443/preview/session/grid/api',
    );
  });

  test('keeps browser requests on the public server if an advertised path lacks the base prefix', () => {
    expect(middlewareEndpointForBrowser('/ax?device=DEVICE-A', publicMount, '/internal')).toBe(
      'https://stream.example.test:8443/preview/session/ax?device=DEVICE-A',
    );
  });
});
