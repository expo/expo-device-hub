import { describe, expect, test } from 'bun:test';

import { resolveIosPreviewConfig } from '../useIosDevice';

describe('resolveIosPreviewConfig', () => {
  test('preserves serve-sim WebRTC codec and ICE settings', () => {
    const resolved = resolveIosPreviewConfig(
      {
        url: 'http://127.0.0.1:3101',
        streamUrl: 'http://127.0.0.1:3101/stream.mjpeg',
        wsUrl: 'ws://localhost/helper/DEVICE-A/ws',
        device: 'DEVICE-A',
        streamSettings: {
          transport: 'webrtc',
          codec: 'vp8',
          iceServers: [
            {
              urls: ['turns:relay.example.test:443'],
              username: 'viewer',
              credential: 'secret',
            },
          ],
        },
      },
      { protocol: 'https:', host: 'hub.example.test' },
      'https://hub.example.test/vendor/serve-sim',
    );

    expect(resolved).toMatchObject({
      webRtcCodec: 'vp8',
      iceServers: [
        {
          urls: ['turns:relay.example.test:443'],
          username: 'viewer',
          credential: 'secret',
        },
      ],
    });
  });

  test('falls back safely when advertised WebRTC settings are malformed', () => {
    const resolved = resolveIosPreviewConfig(
      {
        url: 'http://127.0.0.1:3101',
        wsUrl: 'ws://localhost/helper/DEVICE-A/ws',
        device: 'DEVICE-A',
        streamSettings: {
          transport: 'webrtc',
          codec: 'unknown',
          iceServers: [{ urls: ['https://not-an-ice-server.example.test'] }],
        },
      },
      { protocol: 'https:', host: 'hub.example.test' },
      'https://hub.example.test/vendor/serve-sim',
    );

    expect(resolved.webRtcCodec).toBe('h264');
    expect(resolved.iceServers).toBeUndefined();
  });
});
