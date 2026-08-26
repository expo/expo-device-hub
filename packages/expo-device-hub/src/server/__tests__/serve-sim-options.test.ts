import { describe, expect, test } from 'bun:test';

import { parseCliOptions } from '../cli/options';
import {
  encodeStandaloneServeSimOptions,
  readStandaloneServeSimOptions,
  standaloneServeSimOptions,
} from '../serve-sim-options';

describe('standaloneServeSimOptions', () => {
  test('maps Hub HTTP transports to serve-sim codecs', () => {
    expect(standaloneServeSimOptions(parseCliOptions(['--transport', 'mjpeg']))).toEqual({
      streamSettings: { transport: 'http', codec: 'mjpeg' },
    });
    expect(standaloneServeSimOptions(parseCliOptions(['--transport', 'h264']))).toEqual({
      streamSettings: { transport: 'http', codec: 'h264' },
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
      streamSettings: {
        transport: 'webrtc',
        codec: 'vp9',
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
      streamSettings: { transport: 'webrtc', codec: 'h264' },
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

  test('round-trips through the server environment payload', () => {
    const options = parseCliOptions(['--transport', 'webrtc', '--webrtc-codec', 'vp8']);
    expect(readStandaloneServeSimOptions(encodeStandaloneServeSimOptions(options))).toEqual(
      standaloneServeSimOptions(options),
    );
    expect(readStandaloneServeSimOptions('not json')).toEqual({});
  });
});
