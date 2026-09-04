import { describe, expect, test } from 'bun:test';

import {
  androidStreamSettingsPatch,
  parseAndroidStreamSettings,
} from '../android-stream-settings';
import {
  androidStreamSourceErrorMessage,
  parseAndroidStreamSource,
} from '../android-stream-source';
import {
  fixedWebCodecsCodec,
  isRawVideoKeyFrame,
  isWebCodecsUnsupportedError,
  mseFallbackCodecError,
  parseAndroidVideoSession,
  resolveVideoKeyFrame,
  webCodecsCodec,
} from '../android-video-codec';
import { parseFramePacket } from '../h264';
import {
  androidWsUrlFor,
  parseServeEmuStreamSettings,
  parseServeEmuViewerTransports,
} from '../useAndroidDevice';

describe('serve-emu stream contract', () => {
  test('uses a metadata video socket for H.264 and an input-only socket for WebRTC', () => {
    expect(androidWsUrlFor('http://localhost:3400/vendor/serve-emu', 'emulator-5554', true)).toBe(
      'ws://localhost:3400/vendor/serve-emu/ws?frame-meta=1&device=emulator-5554',
    );
    expect(androidWsUrlFor('https://hub.test/vendor/serve-emu/', 'pixel 9', false)).toBe(
      'wss://hub.test/vendor/serve-emu/ws?video=0&device=pixel+9',
    );
  });

  test('parses authoritative codec generation boundaries for WebSocket video', () => {
    expect(
      parseAndroidVideoSession({
        type: 'video-session',
        size: { width: 1080, height: 2400 },
        codec: 'vp9',
      }),
    ).toEqual({ size: { width: 1080, height: 2400 }, codec: 'vp9' });
    expect(
      parseAndroidVideoSession({
        type: 'video-session',
        size: { width: 1080, height: 2400 },
      }),
    ).toEqual({ size: { width: 1080, height: 2400 }, codec: 'h264' });
    expect(
      parseAndroidVideoSession({
        type: 'video-session',
        size: { width: 0, height: 2400 },
        codec: 'vp8',
      }),
    ).toBeNull();
    expect(fixedWebCodecsCodec('h264')).toBeNull();
    expect(fixedWebCodecsCodec('vp8')).toBe('vp8');
    expect(fixedWebCodecsCodec('vp9')).toBe('vp09.00.10.08');
    expect(webCodecsCodec('h264', Uint8Array.of(0x67, 0x64, 0, 0x29))).toBe('avc1.640029');
    expect(webCodecsCodec('h264', Uint8Array.of(0x67, 0x64))).toBeNull();
    expect(mseFallbackCodecError('h264')).toBeNull();
    expect(mseFallbackCodecError('h264', false)).toBe(
      'This browser cannot decode H.264 (WebCodecs unavailable).',
    );
    expect(mseFallbackCodecError('vp8')).toBe(
      'VP8 WebSocket video requires WebCodecs.',
    );
    expect(isWebCodecsUnsupportedError({ name: 'NotSupportedError' })).toBe(true);
    expect(isWebCodecsUnsupportedError(new Error('decode failed'))).toBe(false);
  });

  test('recovers VPx keyframes from raw payloads only when SEMU metadata is absent', () => {
    const vp8Key = Uint8Array.of(0xf0, 0x02, 0, 0x9d, 0x01, 0x2a, 0x10, 0, 0x10, 0);
    const vp9Key = Uint8Array.of(0x82, 0x49, 0x83, 0x42);

    expect(isRawVideoKeyFrame('vp8', vp8Key)).toBe(true);
    expect(isRawVideoKeyFrame('vp8', Uint8Array.of(0xb1, 1, 0, 5))).toBe(false);
    expect(isRawVideoKeyFrame('vp9', vp9Key)).toBe(true);
    expect(isRawVideoKeyFrame('vp9', Uint8Array.of(0x82, 0, 0, 0))).toBe(false);
    expect(resolveVideoKeyFrame('vp8', false, vp8Key)).toBe(false);
    expect(resolveVideoKeyFrame('vp9', true, Uint8Array.of(1, 2, 3))).toBe(true);
    expect(resolveVideoKeyFrame('vp8', null, vp8Key)).toBe(true);
  });

  test('reads keyframe and PTS metadata from SEMU v1 and v2 packets', () => {
    const packet = (version: 1 | 2, payload: number[]) => {
      const headerBytes = version === 1 ? 16 : 24;
      const bytes = new Uint8Array(headerBytes + payload.length);
      const view = new DataView(bytes.buffer);
      view.setUint32(0, 0x53454d55, false);
      view.setUint8(4, version);
      view.setUint8(5, 1);
      view.setBigUint64(8, 123_456n, false);
      if (version === 2) view.setBigUint64(16, 987_654_321n, false);
      bytes.set(payload, headerBytes);
      return bytes;
    };

    for (const version of [1, 2] as const) {
      const parsed = parseFramePacket(packet(version, [1, 2, 3]));
      expect(parsed.isKey).toBe(true);
      expect(parsed.timestamp).toBe(123_456);
      expect([...parsed.data]).toEqual([1, 2, 3]);
    }
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

  test('disables WebRTC when the active source codec only supports WebSocket viewing', () => {
    expect(
      parseServeEmuViewerTransports({
        default: 'websocket',
        available: ['websocket'],
        webrtc: null,
      }),
    ).toEqual({ transport: 'websocket' });
    expect(
      parseServeEmuViewerTransports({
        default: 'webrtc',
        available: ['websocket', 'webrtc'],
        webrtc: {
          transport: 'webrtc',
          codec: 'h264',
          iceServers: [{ urls: ['stun:stun.example.test:3478'] }],
          iceTransportPolicy: 'all',
        },
      }),
    ).toMatchObject({ transport: 'webrtc', codec: 'h264' });
    expect(parseServeEmuViewerTransports({ available: ['webtransport'] })).toBeNull();
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

describe('serve-emu runtime stream settings contract', () => {
  test('patches only Android resolution with a validated max dimension', () => {
    expect(
      androidStreamSettingsPatch({
        maxDimension: 720,
        mjpegFps: 15,
        mjpegQuality: 0.45,
        h264Fps: 30,
        h264Bitrate: 3_000_000,
      }),
    ).toEqual({ maxDimension: 720 });
    expect(androidStreamSettingsPatch({ h264Fps: 30 })).toBeNull();
    expect(androidStreamSettingsPatch({ maxDimension: Number.NaN })).toBeNull();
    expect(androidStreamSettingsPatch({ maxDimension: 720.5 })).toBeNull();
    expect(androidStreamSettingsPatch({ maxDimension: -1 })).toBeNull();
    expect(androidStreamSettingsPatch({ maxDimension: 4_097 })).toBeNull();
  });

  test('accepts only authoritative responses that include a valid max dimension', () => {
    expect(
      parseAndroidStreamSettings({
        maxDimension: 720,
        h264Bitrate: 8_000_000,
        h264Fps: 30,
      }),
    ).toEqual({
      maxDimension: 720,
      mjpegFps: 60,
      mjpegQuality: 0.7,
      h264Bitrate: 8_000_000,
      h264Fps: 30,
    });
    expect(parseAndroidStreamSettings({ h264Bitrate: 8_000_000, h264Fps: 30 })).toBeNull();
    expect(parseAndroidStreamSettings({ maxDimension: '720' })).toBeNull();
    expect(parseAndroidStreamSettings({ maxDimension: 720.5 })).toBeNull();
  });
});

describe('serve-emu capture source contract', () => {
  test('surfaces backend source-switch failures with an HTTP fallback', () => {
    expect(
      androidStreamSourceErrorMessage(503, { error: 'Emulator gRPC endpoint is unavailable' }),
    ).toBe('Unable to change stream source: Emulator gRPC endpoint is unavailable');
    expect(androidStreamSourceErrorMessage(500, null)).toBe(
      'Unable to change stream source (HTTP 500).',
    );
  });

  test('accepts authoritative scrcpy and gRPC source responses', () => {
    expect(
      parseAndroidStreamSource({
        ok: true,
        serial: 'emulator-5554',
        mode: 'grpc-screenshot',
        grpcImageMode: 'mmap',
        inputSource: 'scrcpy',
        availableInputSources: ['scrcpy', 'grpc'],
        grpcVideoCodec: 'vp8',
        availableModes: ['scrcpy', 'grpc-screenshot'],
        sessionGeneration: 2,
      }),
    ).toEqual({
      mode: 'grpc-screenshot',
      grpcImageMode: 'mmap',
      inputSource: 'scrcpy',
      availableInputSources: ['scrcpy', 'grpc'],
      grpcVideoCodec: 'vp8',
      availableModes: ['scrcpy', 'grpc-screenshot'],
      sessionGeneration: 2,
    });
    expect(
      parseAndroidStreamSource({
        ok: true,
        serial: 'usb-device',
        mode: 'scrcpy',
        grpcImageMode: 'png',
        inputSource: 'scrcpy',
        availableInputSources: ['scrcpy'],
        availableModes: ['scrcpy'],
        sessionGeneration: 0,
      }),
    ).toEqual({
      mode: 'scrcpy',
      grpcImageMode: 'png',
      inputSource: 'scrcpy',
      availableInputSources: ['scrcpy'],
      grpcVideoCodec: 'h264',
      availableModes: ['scrcpy'],
      sessionGeneration: 0,
    });
  });

  test('rejects malformed, inconsistent, and unsupported source responses', () => {
    expect(parseAndroidStreamSource({ ok: false })).toBeNull();
    expect(
      parseAndroidStreamSource({
        ok: true,
        mode: 'grpc-screenshot',
        availableModes: ['scrcpy'],
        sessionGeneration: 0,
      }),
    ).toBeNull();
    expect(
      parseAndroidStreamSource({
        ok: true,
        mode: 'camera',
        availableModes: ['camera'],
        sessionGeneration: 0,
      }),
    ).toBeNull();
    expect(
      parseAndroidStreamSource({
        ok: true,
        mode: 'scrcpy',
        availableModes: ['scrcpy', 'scrcpy'],
        sessionGeneration: -1,
      }),
    ).toBeNull();
  });
});
