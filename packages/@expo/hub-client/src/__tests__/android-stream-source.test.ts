import { describe, expect, test } from 'bun:test';

import {
  androidStreamSourceSupportsWebRtc,
  parseAndroidStreamSource,
} from '../android-stream-source';

describe('parseAndroidStreamSource', () => {
  test('parses the authoritative gRPC image mode', () => {
    expect(
      parseAndroidStreamSource({
        ok: true,
        mode: 'grpc-screenshot',
        grpcImageMode: 'mmap',
        inputSource: 'scrcpy',
        availableInputSources: ['scrcpy', 'grpc'],
        grpcVideoCodec: 'vp9',
        availableModes: ['scrcpy', 'grpc-screenshot'],
        sessionGeneration: 4,
      }),
    ).toEqual({
      mode: 'grpc-screenshot',
      grpcImageMode: 'mmap',
      inputSource: 'scrcpy',
      availableInputSources: ['scrcpy', 'grpc'],
      grpcVideoCodec: 'vp9',
      availableModes: ['scrcpy', 'grpc-screenshot'],
      sessionGeneration: 4,
    });
  });

  test('uses WebRTC only for sources backed by H.264', () => {
    expect(androidStreamSourceSupportsWebRtc(null)).toBeTrue();
    expect(
      androidStreamSourceSupportsWebRtc({
        mode: 'scrcpy',
        grpcImageMode: 'png',
        inputSource: 'scrcpy',
        availableInputSources: ['scrcpy'],
        grpcVideoCodec: 'vp9',
        availableModes: ['scrcpy', 'grpc-screenshot'],
        sessionGeneration: 1,
      }),
    ).toBeTrue();
    expect(
      androidStreamSourceSupportsWebRtc({
        mode: 'grpc-screenshot',
        grpcImageMode: 'mmap',
        inputSource: 'scrcpy',
        availableInputSources: ['scrcpy', 'grpc'],
        grpcVideoCodec: 'h264',
        availableModes: ['scrcpy', 'grpc-screenshot'],
        sessionGeneration: 2,
      }),
    ).toBeTrue();
    expect(
      androidStreamSourceSupportsWebRtc({
        mode: 'grpc-screenshot',
        grpcImageMode: 'mmap',
        inputSource: 'scrcpy',
        availableInputSources: ['scrcpy', 'grpc'],
        grpcVideoCodec: 'vp8',
        availableModes: ['scrcpy', 'grpc-screenshot'],
        sessionGeneration: 3,
      }),
    ).toBeFalse();
    expect(
      androidStreamSourceSupportsWebRtc({
        mode: 'grpc-screenshot',
        grpcImageMode: 'mmap',
        inputSource: 'grpc',
        availableInputSources: ['scrcpy', 'grpc'],
        grpcVideoCodec: 'vp9',
        availableModes: ['scrcpy', 'grpc-screenshot'],
        sessionGeneration: 4,
      }),
    ).toBeFalse();
  });

  test('defaults legacy responses without a video codec to H.264', () => {
    expect(
      parseAndroidStreamSource({
        ok: true,
        mode: 'grpc-screenshot',
        grpcImageMode: 'png',
        inputSource: 'scrcpy',
        availableInputSources: ['scrcpy', 'grpc'],
        availableModes: ['scrcpy', 'grpc-screenshot'],
        sessionGeneration: 1,
      }),
    ).toMatchObject({ grpcVideoCodec: 'h264' });
  });

  test('rejects missing or unsupported image modes', () => {
    const response = {
      ok: true,
      mode: 'grpc-screenshot',
      inputSource: 'scrcpy',
      availableInputSources: ['scrcpy', 'grpc'],
      availableModes: ['scrcpy', 'grpc-screenshot'],
      sessionGeneration: 1,
    };
    expect(parseAndroidStreamSource(response)).toBeNull();
    expect(parseAndroidStreamSource({ ...response, grpcImageMode: 'rgb' })).toBeNull();
    expect(
      parseAndroidStreamSource({
        ...response,
        grpcImageMode: 'png',
        grpcVideoCodec: 'av1',
      }),
    ).toBeNull();
  });

  test('rejects unavailable or unsupported input sources', () => {
    const response = {
      ok: true,
      mode: 'grpc-screenshot',
      grpcImageMode: 'png',
      inputSource: 'scrcpy',
      availableInputSources: ['scrcpy', 'grpc'],
      availableModes: ['scrcpy', 'grpc-screenshot'],
      sessionGeneration: 1,
    };
    expect(parseAndroidStreamSource({ ...response, inputSource: 'adb' })).toBeNull();
    expect(
      parseAndroidStreamSource({ ...response, availableInputSources: ['grpc'] }),
    ).toBeNull();
  });
});
