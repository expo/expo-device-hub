import { describe, expect, test } from 'bun:test';

import { androidWsUrlFor, parseServeEmuStreamSettings } from '../useAndroidDevice';

describe('serve-emu stream contract', () => {
  test('uses a metadata video socket for H.264 and an input-only socket for WebRTC', () => {
    expect(androidWsUrlFor('http://localhost:3400/vendor/serve-emu', 'emulator-5554', true)).toBe(
      'ws://localhost:3400/vendor/serve-emu/ws?frame-meta=1&device=emulator-5554',
    );
    expect(androidWsUrlFor('https://hub.test/vendor/serve-emu/', 'pixel 9', false)).toBe(
      'wss://hub.test/vendor/serve-emu/ws?video=0&device=pixel+9',
    );
  });

  test('accepts the host-owned H.264 WebRTC configuration', () => {
    expect(
      parseServeEmuStreamSettings({
        transport: 'webrtc',
        codec: 'h264',
        iceServers: [
          { urls: ['stun:stun.example.test:3478'] },
          {
            urls: ['turn:turn.example.test:3478'],
            username: 'hub',
            credential: 'secret',
          },
        ],
        iceTransportPolicy: 'relay',
      }),
    ).toEqual({
      transport: 'webrtc',
      codec: 'h264',
      iceServers: [
        { urls: ['stun:stun.example.test:3478'] },
        {
          urls: ['turn:turn.example.test:3478'],
          username: 'hub',
          credential: 'secret',
        },
      ],
      iceTransportPolicy: 'relay',
    });
  });

  test('rejects unsupported codecs and malformed ICE settings', () => {
    expect(parseServeEmuStreamSettings({ transport: 'websocket' })).toEqual({
      transport: 'websocket',
    });
    expect(
      parseServeEmuStreamSettings({
        transport: 'webrtc',
        codec: 'vp8',
        iceServers: [],
        iceTransportPolicy: 'all',
      }),
    ).toBeNull();
    expect(
      parseServeEmuStreamSettings({
        transport: 'webrtc',
        codec: 'h264',
        iceServers: [{ urls: ['stun:ok.test'], credential: 123 }],
        iceTransportPolicy: 'all',
      }),
    ).toBeNull();
  });
});
