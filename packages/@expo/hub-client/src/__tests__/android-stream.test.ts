import { describe, expect, test } from 'bun:test';

import {
  androidStreamSettingsPatch,
  parseAndroidStreamSettings,
} from '../android-stream-settings';
import { parseAndroidStreamSource } from '../android-stream-source';
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
  test('accepts authoritative scrcpy and gRPC source responses', () => {
    expect(
      parseAndroidStreamSource({
        ok: true,
        serial: 'emulator-5554',
        mode: 'grpc-screenshot',
        availableModes: ['scrcpy', 'grpc-screenshot'],
        sessionGeneration: 2,
      }),
    ).toEqual({
      mode: 'grpc-screenshot',
      availableModes: ['scrcpy', 'grpc-screenshot'],
      sessionGeneration: 2,
    });
    expect(
      parseAndroidStreamSource({
        ok: true,
        serial: 'usb-device',
        mode: 'scrcpy',
        availableModes: ['scrcpy'],
        sessionGeneration: 0,
      }),
    ).toEqual({
      mode: 'scrcpy',
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
