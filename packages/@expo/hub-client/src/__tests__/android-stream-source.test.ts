import { describe, expect, test } from 'bun:test';

import { parseAndroidStreamSource } from '../android-stream-source';

describe('parseAndroidStreamSource', () => {
  test('parses the authoritative gRPC image mode', () => {
    expect(
      parseAndroidStreamSource({
        ok: true,
        mode: 'grpc-screenshot',
        grpcImageMode: 'mmap',
        inputSource: 'scrcpy',
        availableInputSources: ['scrcpy', 'grpc'],
        availableModes: ['scrcpy', 'grpc-screenshot'],
        sessionGeneration: 4,
      }),
    ).toEqual({
      mode: 'grpc-screenshot',
      grpcImageMode: 'mmap',
      inputSource: 'scrcpy',
      availableInputSources: ['scrcpy', 'grpc'],
      availableModes: ['scrcpy', 'grpc-screenshot'],
      sessionGeneration: 4,
    });
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
