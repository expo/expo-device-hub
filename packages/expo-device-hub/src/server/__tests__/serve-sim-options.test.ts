import { describe, expect, test } from 'bun:test';

import { parseCliOptions } from '../cli/options';
import {
  encodeStandaloneServeSimOptions,
  readStandaloneServeSimOptions,
  standaloneServeSimOptions,
} from '../serve-sim-options';

describe('standaloneServeSimOptions', () => {
  test('allows network capture only when the hub binds to loopback', () => {
    expect(standaloneServeSimOptions(parseCliOptions([])).loopbackOnly).toBe(true);
    expect(standaloneServeSimOptions(parseCliOptions(['--host', 'localhost'])).loopbackOnly).toBe(true);
    expect(standaloneServeSimOptions(parseCliOptions(['--host', '0.0.0.0'])).loopbackOnly).toBe(false);
    expect(standaloneServeSimOptions(parseCliOptions(['--host', '10.0.1.112'])).loopbackOnly).toBe(false);
    // A name that starts with 127 is not a loopback address.
    expect(standaloneServeSimOptions(parseCliOptions(['--host', '127.example.com'])).loopbackOnly).toBe(false);
  });

  test('maps Hub HTTP transports with the default 60 FPS to serve-sim', () => {
    expect(standaloneServeSimOptions(parseCliOptions([]))).toEqual({
      loopbackOnly: true,
      streamSettings: { transport: 'http', h264Fps: 60 },
    });
    expect(standaloneServeSimOptions(parseCliOptions(['--transport', 'mjpeg']))).toEqual({
      loopbackOnly: true,
      streamSettings: { transport: 'http', codec: 'mjpeg', h264Fps: 60 },
    });
    expect(standaloneServeSimOptions(parseCliOptions(['--transport', 'h264']))).toEqual({
      loopbackOnly: true,
      streamSettings: { transport: 'http', codec: 'h264', h264Fps: 60 },
    });
  });

  test('maps WebRTC codec and ICE servers', () => {
    expect(
      standaloneServeSimOptions(
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
        ]),
      ),
    ).toEqual({
      loopbackOnly: true,
      streamSettings: {
        transport: 'webrtc',
        codec: 'vp9',
        h264Fps: 60,
        iceServers: [
          { urls: ['stun:one.test', 'stun:two.test'] },
          {
            urls: ['turn:relay.test'],
            username: 'alice',
            credential: 'secret',
          },
        ],
      },
    });
  });

  test('uses the serve-sim WebRTC codec default', () => {
    expect(standaloneServeSimOptions(parseCliOptions(['--transport', 'webrtc']))).toEqual({
      loopbackOnly: true,
      streamSettings: { transport: 'webrtc', codec: 'h264', h264Fps: 60 },
    });
  });

  test('maps encoder settings and metrics CORS origins', () => {
    expect(
      standaloneServeSimOptions(
        parseCliOptions([
          '--max-dimension',
          '1280',
          '--mjpeg-quality',
          '0.75',
          '--video-bitrate',
          '4000000',
          '--video-fps',
          '24',
          '--metrics-cors-origin',
          'https://metrics.test',
        ]),
      ),
    ).toEqual({
      loopbackOnly: true,
      streamSettings: {
        transport: 'http',
        maxDimension: 1280,
        mjpegQuality: 0.75,
        h264Bitrate: 4_000_000,
        h264Fps: 24,
      },
      metricsCorsOrigins: ['https://metrics.test'],
    });
  });

  test('allows each --cors-origin page, as serve-sim --cors-origin does', () => {
    expect(
      standaloneServeSimOptions(parseCliOptions(['--cors-origin', 'https://example.com'])).corsOrigins,
    ).toEqual(['https://example.com']);
    expect(standaloneServeSimOptions(parseCliOptions([])).corsOrigins).toBeUndefined();
  });

  test('round-trips through the server environment payload', () => {
    const options = parseCliOptions(['--transport', 'webrtc', '--webrtc-codec', 'vp8']);
    expect(readStandaloneServeSimOptions(encodeStandaloneServeSimOptions(options))).toEqual(
      standaloneServeSimOptions(options),
    );
    expect(readStandaloneServeSimOptions('not json')).toEqual({});
  });
});
