import { describe, expect, test } from 'bun:test';

import { HELP, parseCliOptions } from '../cli/options';

describe('parseCliOptions', () => {
  test('keeps the existing defaults when no options are provided', () => {
    expect(parseCliOptions([])).toEqual({
      port: undefined,
      host: '127.0.0.1',
      platform: undefined,
      transport: undefined,
      webrtcCodec: undefined,
      maxDimension: undefined,
      mjpegQuality: undefined,
      videoBitrate: undefined,
      videoFps: undefined,
      streamSource: undefined,
      grpcImageMode: undefined,
      grpcVideoCodec: undefined,
      stunUrls: undefined,
      turnUrls: undefined,
      turnUsername: undefined,
      turnCredential: undefined,
      webrtcIcePolicy: undefined,
      metricsCorsOrigins: [],
      hideSidebar: false,
      hideBootDevice: false,
      help: false,
    });
  });

  test('accepts each supported platform', () => {
    expect(parseCliOptions(['--platform', 'ios']).platform).toBe('ios');
    expect(parseCliOptions(['--platform=android']).platform).toBe('android');
  });

  test('rejects unsupported platforms', () => {
    expect(() => parseCliOptions(['--platform', 'web'])).toThrow('Invalid --platform: web');
  });

  test('accepts each supported transport', () => {
    expect(parseCliOptions(['--transport', 'mjpeg']).transport).toBe('mjpeg');
    expect(parseCliOptions(['--transport=h264']).transport).toBe('h264');
    expect(parseCliOptions(['--transport', 'webrtc']).transport).toBe('webrtc');
  });

  test('rejects unsupported transports', () => {
    expect(() => parseCliOptions(['--transport', 'auto'])).toThrow('Invalid --transport: auto');
  });

  test('parses serve-sim WebRTC options', () => {
    expect(
      parseCliOptions([
        '--transport',
        'webrtc',
        '--webrtc-codec',
        'VP8',
        '--stun-url',
        'stun:one.test,stuns:two.test',
        '--turn-url=turn:relay.test,turns:secure-relay.test',
        '--turn-username',
        'alice',
        '--turn-credential',
        'secret',
        '--webrtc-ice-policy',
        'relay',
      ])
    ).toMatchObject({
      transport: 'webrtc',
      webrtcCodec: 'vp8',
      stunUrls: ['stun:one.test', 'stuns:two.test'],
      turnUrls: ['turn:relay.test', 'turns:secure-relay.test'],
      turnUsername: 'alice',
      turnCredential: 'secret',
      webrtcIcePolicy: 'relay',
    });
  });

  test('parses serve-sim encoder and metrics options', () => {
    expect(
      parseCliOptions([
        '--max-dimension=1920',
        '--mjpeg-quality',
        '0.8',
        '--video-bitrate',
        '8000000',
        '--video-fps',
        '30',
        '--metrics-cors-origin',
        'https://one.test',
        '--metrics-cors-origin=https://two.test',
      ])
    ).toMatchObject({
      maxDimension: 1920,
      mjpegQuality: 0.8,
      videoBitrate: 8_000_000,
      videoFps: 30,
      metricsCorsOrigins: ['https://one.test', 'https://two.test'],
    });
  });

  test('selects the Android gRPC source, image mode, and normalized video codec', () => {
    expect(
      parseCliOptions([
        '--platform',
        'android',
        '--stream-source',
        'GRPC-SCREENSHOT',
        '--grpc-image-mode',
        'MMAP',
        '--grpc-video-codec',
        'VP9',
      ]),
    ).toMatchObject({
      streamSource: 'grpc-screenshot',
      grpcImageMode: 'mmap',
      grpcVideoCodec: 'vp9',
    });
  });

  test('validates Android stream-source options', () => {
    expect(() => parseCliOptions(['--stream-source', 'camera'])).toThrow(
      'Invalid --stream-source: camera',
    );
    expect(() => parseCliOptions(['--grpc-image-mode', 'rgb'])).toThrow(
      'Invalid --grpc-image-mode: rgb',
    );
    expect(() => parseCliOptions(['--grpc-video-codec', 'av1'])).toThrow(
      'Invalid --grpc-video-codec: av1',
    );
    expect(() =>
      parseCliOptions(['--platform', 'ios', '--stream-source', 'grpc-screenshot'])
    ).toThrow(
      '--stream-source, --grpc-image-mode, and --grpc-video-codec are supported only for Android',
    );
    expect(() =>
      parseCliOptions(['--platform', 'ios', '--grpc-video-codec', 'vp8'])
    ).toThrow(
      '--stream-source, --grpc-image-mode, and --grpc-video-codec are supported only for Android',
    );
  });

  test('rejects VP8 and VP9 gRPC encoding with the WebRTC transport', () => {
    for (const codec of ['vp8', 'vp9']) {
      expect(() =>
        parseCliOptions([
          '--platform',
          'android',
          '--transport',
          'webrtc',
          '--grpc-video-codec',
          codec,
        ])
      ).toThrow(
        `--grpc-video-codec ${codec} is incompatible with --transport webrtc; use --transport h264 (WebSocket)`
      );
    }
  });

  test('validates serve-sim option ranges and values', () => {
    expect(() => parseCliOptions(['--webrtc-codec', 'av1'])).toThrow(
      'Invalid --webrtc-codec: av1'
    );
    expect(() => parseCliOptions(['--max-dimension', '4097'])).toThrow(
      'Invalid --max-dimension: 4097'
    );
    expect(() => parseCliOptions(['--mjpeg-quality', '0'])).toThrow(
      'Invalid --mjpeg-quality: 0'
    );
    expect(() => parseCliOptions(['--video-bitrate', '99999'])).toThrow(
      'Invalid --video-bitrate: 99999'
    );
    expect(() => parseCliOptions(['--video-fps', '29.97'])).toThrow(
      'Invalid --video-fps: 29.97'
    );
    expect(() =>
      parseCliOptions(['--transport', 'webrtc', '--stun-url', 'https://bad.test'])
    ).toThrow('Invalid --stun-url');
  });

  test('requires a WebRTC transport and complete TURN credentials', () => {
    expect(() => parseCliOptions(['--webrtc-codec', 'vp8'])).toThrow(
      'WebRTC options require --transport webrtc'
    );
    expect(() =>
      parseCliOptions([
        '--transport',
        'webrtc',
        '--turn-url',
        'turn:relay.test',
        '--turn-username',
        'alice',
      ])
    ).toThrow('--turn-username and --turn-credential must be provided together');
    expect(() =>
      parseCliOptions([
        '--transport',
        'webrtc',
        '--turn-username',
        'alice',
        '--turn-credential',
        'secret',
      ])
    ).toThrow('--turn-username and --turn-credential require --turn-url');
    expect(() => parseCliOptions(['--webrtc-ice-policy', 'all'])).toThrow(
      'WebRTC options require --transport webrtc'
    );
    expect(() =>
      parseCliOptions(['--transport', 'webrtc', '--webrtc-ice-policy', 'relay'])
    ).toThrow('--webrtc-ice-policy relay requires --turn-url');
    expect(() =>
      parseCliOptions(['--transport', 'webrtc', '--webrtc-ice-policy', 'host'])
    ).toThrow('Invalid --webrtc-ice-policy: host');
    expect(() =>
      parseCliOptions([
        '--platform',
        'ios',
        '--transport',
        'webrtc',
        '--webrtc-ice-policy',
        'all',
      ])
    ).toThrow('--webrtc-ice-policy is supported only for Android');
  });

  test('documents every serve-sim flag', () => {
    for (const flag of [
      '--webrtc-codec',
      '--max-dimension',
      '--mjpeg-quality',
      '--video-bitrate',
      '--video-fps',
      '--stream-source',
      '--grpc-image-mode',
      '--grpc-video-codec',
      '--stun-url',
      '--turn-url',
      '--turn-username',
      '--turn-credential',
      '--webrtc-ice-policy',
      '--metrics-cors-origin',
    ]) {
      expect(HELP).toContain(flag);
    }
    expect(HELP).toContain('used when the gRPC source is active');
  });

  test('documents the default Android gRPC MMAP stream', () => {
    expect(HELP).toContain('--stream-source <source>');
    expect(HELP).toContain('(default: grpc-screenshot)');
    expect(HELP).toContain('--grpc-image-mode <mode>');
    expect(HELP).toContain('default: mmap');
    expect(HELP).toContain('--grpc-video-codec <codec>');
    expect(HELP).toContain('default: h264');
  });

  test('hides the device list sidebar on request', () => {
    expect(parseCliOptions(['--hide-sidebar']).hideSidebar).toBe(true);
    expect(HELP).toContain('--hide-sidebar');
  });

  test('hides controls for booting or creating devices on request', () => {
    expect(parseCliOptions(['--hide-boot-device']).hideBootDevice).toBe(true);
    expect(HELP).toContain('--hide-boot-device');
  });

  test('replaces the old stream-mode flag', () => {
    expect(HELP).toContain('--transport <transport>');
    expect(HELP).not.toContain('--stream-mode');
    expect(() => parseCliOptions(['--stream-mode', 'webrtc'])).toThrow(
      "Unknown option '--stream-mode'"
    );
  });

  test('parses the existing host, port, and help options', () => {
    expect(parseCliOptions(['--host', '0.0.0.0', '-p', '4300'])).toEqual({
      port: 4300,
      host: '0.0.0.0',
      platform: undefined,
      transport: undefined,
      webrtcCodec: undefined,
      maxDimension: undefined,
      mjpegQuality: undefined,
      videoBitrate: undefined,
      videoFps: undefined,
      streamSource: undefined,
      grpcImageMode: undefined,
      grpcVideoCodec: undefined,
      stunUrls: undefined,
      turnUrls: undefined,
      turnUsername: undefined,
      turnCredential: undefined,
      webrtcIcePolicy: undefined,
      metricsCorsOrigins: [],
      hideSidebar: false,
      hideBootDevice: false,
      help: false,
    });
    expect(parseCliOptions(['--help'])).toEqual({ host: '127.0.0.1', help: true });
  });
});
