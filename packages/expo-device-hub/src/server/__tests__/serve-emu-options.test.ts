import { describe, expect, test } from 'bun:test';

import { parseCliOptions } from '../cli/options';
import {
  DEFAULT_SERVE_EMU_ICE_SERVERS,
  encodeStandaloneServeEmuOptions,
  readStandaloneServeEmuOptions,
  serveEmuWebSocketOptions,
  standaloneServeEmuOptions,
} from '../serve-emu-options';

describe('standaloneServeEmuOptions', () => {
  test('uses serve-emu WebSocket defaults without Hub stream flags', () => {
    expect(standaloneServeEmuOptions(parseCliOptions([]))).toEqual({
      streamSettings: { transport: 'websocket' },
    });
    expect(standaloneServeEmuOptions(parseCliOptions(['--transport', 'mjpeg']))).toEqual({
      streamSettings: { transport: 'websocket' },
    });
    expect(standaloneServeEmuOptions(parseCliOptions(['--transport', 'h264']))).toEqual({
      streamSettings: { transport: 'websocket' },
    });
  });

  test('maps shared encoder flags onto scrcpy startup options', () => {
    expect(
      standaloneServeEmuOptions(
        parseCliOptions([
          '--max-dimension',
          '1280',
          '--video-bitrate',
          '4000000',
          '--video-fps',
          '24',
          '--mjpeg-quality',
          '0.75',
        ]),
      ),
    ).toEqual({
      maxSize: 1280,
      bitRate: 4_000_000,
      maxFps: 24,
      streamSettings: { transport: 'websocket' },
    });
  });

  test('maps the selected gRPC source and MMAP image mode', () => {
    expect(
      standaloneServeEmuOptions(
        parseCliOptions([
          '--stream-source',
          'grpc-screenshot',
          '--grpc-image-mode',
          'mmap',
        ]),
      ),
    ).toEqual({
      streamMode: 'grpc-screenshot',
      grpcImageMode: 'mmap',
      streamSettings: { transport: 'websocket' },
    });
  });

  test('maps host WebRTC settings while keeping Android on H.264', () => {
    expect(
      standaloneServeEmuOptions(
        parseCliOptions([
          '--transport',
          'webrtc',
          '--webrtc-codec',
          'vp9',
          '--stun-url',
          'stun:one.test,stun:two.test',
          '--turn-url',
          'turn:relay.test',
          '--turn-username',
          'alice',
          '--turn-credential',
          'secret',
          '--webrtc-ice-policy',
          'relay',
        ]),
      ),
    ).toEqual({
      streamSettings: {
        transport: 'webrtc',
        codec: 'h264',
        iceServers: [
          { urls: ['stun:one.test', 'stun:two.test'] },
          {
            urls: ['turn:relay.test'],
            username: 'alice',
            credential: 'secret',
          },
        ],
        iceTransportPolicy: 'relay',
      },
    });
  });

  test('uses serve-emu WebRTC ICE defaults', () => {
    expect(standaloneServeEmuOptions(parseCliOptions(['--transport', 'webrtc']))).toEqual({
      streamSettings: {
        transport: 'webrtc',
        codec: 'h264',
        iceServers: DEFAULT_SERVE_EMU_ICE_SERVERS,
        iceTransportPolicy: 'all',
      },
    });
  });

  test('keeps the default STUN servers when only TURN is configured', () => {
    expect(
      standaloneServeEmuOptions(
        parseCliOptions([
          '--transport',
          'webrtc',
          '--turn-url',
          'turn:relay.test',
          '--webrtc-ice-policy',
          'relay',
        ]),
      ).streamSettings,
    ).toEqual({
      transport: 'webrtc',
      codec: 'h264',
      iceServers: [...DEFAULT_SERVE_EMU_ICE_SERVERS, { urls: ['turn:relay.test'] }],
      iceTransportPolicy: 'relay',
    });
  });

  test('round-trips through the server environment payload', () => {
    const options = parseCliOptions([
      '--transport',
      'webrtc',
      '--video-fps',
      '30',
      '--stream-source',
      'grpc-screenshot',
      '--grpc-image-mode',
      'mmap',
    ]);
    expect(readStandaloneServeEmuOptions(encodeStandaloneServeEmuOptions(options))).toEqual(
      standaloneServeEmuOptions(options),
    );
    expect(readStandaloneServeEmuOptions('not json')).toEqual({
      streamSettings: { transport: 'websocket' },
    });
  });
});

describe('serveEmuWebSocketOptions', () => {
  test('keeps WebRTC input sockets video-free', () => {
    expect(
      serveEmuWebSocketOptions(
        new URL('http://localhost/vendor/serve-emu/ws?video=0&frame-meta=1'),
      ),
    ).toEqual({ video: false, frameMeta: false });
  });

  test('requests metadata only for video sockets', () => {
    expect(
      serveEmuWebSocketOptions(new URL('http://localhost/vendor/serve-emu/ws?frame-meta=1')),
    ).toEqual({ video: true, frameMeta: true });
  });
});
