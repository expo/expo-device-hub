import { describe, expect, test } from 'bun:test';

import { type AttachedPreviewApi, isAttachedPreviewApi, resolveIosConnection } from '../ios-connection.js';

const proxiedApi: AttachedPreviewApi = {
  device: 'DEVICE-A',
  basePath: '/internal',
  proxyHelpers: true,
  execToken: 'token',
  url: 'https://sim.example.test:0/internal/helper/DEVICE-A',
  streamUrl: 'https://sim.example.test:0/internal/helper/DEVICE-A/stream.mjpeg',
  wsUrl: 'wss://sim.example.test:0/internal/helper/DEVICE-A/ws',
  streamSettingsEndpoint: 'http://127.0.0.1:49152/stream-settings',
  logsEndpoint: '/internal/logs?device=DEVICE-A',
  eventLogEventsEndpoint: '/internal/api/event-log/events?device=DEVICE-A',
  metricsEndpoint: '/internal/metrics?device=DEVICE-A',
  appStateEndpoint: '/internal/appstate?device=DEVICE-A',
  axEndpoint: '/internal/ax?device=DEVICE-A',
  gridApiEndpoint: '/internal/grid/api',
};

describe('resolveIosConnection with proxied helpers', () => {
  test('resolves every browser URL against the public mount', () => {
    expect(
      resolveIosConnection(proxiedApi, new URL('https://sim.example.test:8443/preview/session/')),
    ).toEqual({
      url: 'https://sim.example.test:8443/preview/session/helper/DEVICE-A',
      streamUrl: 'https://sim.example.test:8443/preview/session/helper/DEVICE-A/stream.mjpeg',
      wsUrl: 'wss://sim.example.test:8443/preview/session/helper/ws?device=DEVICE-A',
      streamSettingsUrl:
        'https://sim.example.test:8443/preview/session/helper/DEVICE-A/stream-settings',
      device: 'DEVICE-A',
      inputAdmission: false,
      execWsUrl: 'wss://sim.example.test:8443/preview/session/exec-ws',
      execToken: 'token',
      // exec-ws subscription paths stay on the server's own mount.
      logsPath: '/internal/logs?device=DEVICE-A',
      eventsPath: '/internal/api/event-log/events?device=DEVICE-A',
      metricsPath: '/internal/metrics?device=DEVICE-A',
      appStateUrl: 'https://sim.example.test:8443/preview/session/appstate?device=DEVICE-A',
      axUrl: 'https://sim.example.test:8443/preview/session/ax?device=DEVICE-A',
      gridApiUrl: 'https://sim.example.test:8443/preview/session/grid/api',
      initialStreamSettings: undefined,
      webRtcCodec: 'h264',
    });
  });

  test('encodes the device in helper URLs', () => {
    const connection = resolveIosConnection(
      { ...proxiedApi, device: 'DEVICE A/B' },
      new URL('https://sim.example.test/'),
    );
    expect(connection.url).toBe('https://sim.example.test/helper/DEVICE%20A%2FB');
    expect(connection.wsUrl).toBe('wss://sim.example.test/helper/ws?device=DEVICE+A%2FB');
  });

  test('falls back to the grid route under the public mount', () => {
    const { gridApiEndpoint: _, ...api } = proxiedApi;
    expect(resolveIosConnection(api, new URL('http://localhost:8081/hub/vendor/serve-sim/')).gridApiUrl)
      .toBe('http://localhost:8081/hub/vendor/serve-sim/grid/api');
  });
});

describe('resolveIosConnection with direct helpers', () => {
  const mount = new URL('http://localhost:3200/');
  const directApi: AttachedPreviewApi = {
    device: 'DEVICE-A',
    basePath: '',
    url: 'http://192.168.1.5:3100/helper/DEVICE-A',
    streamSettingsEndpoint: 'http://192.168.1.5:3100/helper/DEVICE-A/stream-settings',
    axEndpoint: '/ax?device=DEVICE-A',
  };

  test('keeps the advertised helper URLs and derives missing ones from url', () => {
    const connection = resolveIosConnection(directApi, mount);
    expect(connection.url).toBe('http://192.168.1.5:3100/helper/DEVICE-A');
    expect(connection.streamUrl).toBe('http://192.168.1.5:3100/helper/DEVICE-A/stream.mjpeg');
    expect(connection.wsUrl).toBe('ws://192.168.1.5:3100/helper/ws?device=DEVICE-A');
    expect(connection.streamSettingsUrl).toBe(
      'http://192.168.1.5:3100/helper/DEVICE-A/stream-settings',
    );
  });

  test('resolves middleware routes against the mount origin and the server base path', () => {
    const connection = resolveIosConnection(
      { ...directApi, basePath: '/vendor/serve-sim', axEndpoint: '/vendor/serve-sim/ax?device=DEVICE-A' },
      new URL('http://localhost:8081/vendor/serve-sim/'),
    );
    expect(connection.execWsUrl).toBe('ws://localhost:8081/vendor/serve-sim/exec-ws');
    expect(connection.axUrl).toBe('http://localhost:8081/vendor/serve-sim/ax?device=DEVICE-A');
    expect(connection.gridApiUrl).toBe('http://localhost:8081/vendor/serve-sim/grid/api');
  });

  test('reports no optional URLs that the server did not advertise', () => {
    const connection = resolveIosConnection({ device: 'DEVICE-A', url: directApi.url }, mount);
    expect(connection.appStateUrl).toBeNull();
    expect(connection.axUrl).toBeNull();
    expect(connection.streamSettingsUrl).toBeNull();
  });
});

test('resolveIosConnection reads the WebRTC codec and ICE servers', () => {
  const iceServers = [{ urls: ['stun:stun.example.test'] }];
  const connection = resolveIosConnection(
    { ...proxiedApi, streamSettings: { transport: 'webrtc', codec: 'vp8', iceServers } },
    new URL('https://sim.example.test/'),
  );
  expect(connection.webRtcCodec).toBe('vp8');
  expect(connection.webRtcIceServers).toEqual(iceServers);
});

test('isAttachedPreviewApi needs both a helper url and a device', () => {
  expect(isAttachedPreviewApi({ url: 'http://localhost:3100/helper/A', device: 'A' })).toBe(true);
  expect(isAttachedPreviewApi({ device: 'A' })).toBe(false);
  expect(isAttachedPreviewApi(null)).toBe(false);
});
