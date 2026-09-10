import { describe, expect, test } from 'bun:test';

import { parseAndroidStreamSource } from '../android-stream-source';

describe('parseAndroidStreamSource', () => {
  test.each(['png', 'mmap', 'rgb888'])(
    'parses the authoritative %s gRPC image mode',
    (grpcImageMode) => {
      expect(
        parseAndroidStreamSource({
          ok: true,
          mode: 'grpc-screenshot',
          grpcImageMode,
          encoder: 'software',
          encoderName: 'libx264',
          availableEncoders: ['software', 'hardware'],
          inputSource: 'scrcpy',
          availableInputSources: ['scrcpy', 'grpc'],
          availableModes: ['scrcpy', 'grpc-screenshot'],
          sessionGeneration: 4,
        }),
      ).toEqual({
        mode: 'grpc-screenshot',
        grpcImageMode,
        encoder: 'software',
        encoderName: 'libx264',
        availableEncoders: ['software', 'hardware'],
        inputSource: 'scrcpy',
        availableInputSources: ['scrcpy', 'grpc'],
        availableModes: ['scrcpy', 'grpc-screenshot'],
        sessionGeneration: 4,
      });
    },
  );

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
      encoder: 'software',
      encoderName: 'libx264',
      availableEncoders: ['software', 'hardware'],
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


describe('Android gRPC encoder status', () => {
  const response = {
    ok: true,
    mode: 'grpc-screenshot',
    grpcImageMode: 'rgb888',
    encoder: 'hardware',
    encoderName: 'h264_videotoolbox',
    availableEncoders: ['software', 'hardware'],
    inputSource: 'grpc',
    availableInputSources: ['scrcpy', 'grpc'],
    availableModes: ['scrcpy', 'grpc-screenshot'],
    sessionGeneration: 5,
  };

  test('reports the resolved encoder and retains probe errors with the current source', () => {
    expect(parseAndroidStreamSource(response)).toMatchObject({
      encoder: 'hardware',
      encoderName: 'h264_videotoolbox',
      availableEncoders: ['software', 'hardware'],
    });
    expect(parseAndroidStreamSource({ ...response, encoderName: null })).toMatchObject({
      encoder: 'hardware',
      encoderName: null,
    });
    expect(parseAndroidStreamSource({
      ...response,
      encoder: 'software',
      encoderName: 'libx264',
      availableEncoders: ['software'],
      hardwareEncoderError: 'No usable hardware encoder: permission denied.',
    })).toMatchObject({
      encoder: 'software',
      encoderName: 'libx264',
      availableEncoders: ['software'],
      hardwareEncoderError: 'No usable hardware encoder: permission denied.',
      sessionGeneration: 5,
    });
  });

  test('keeps older software-only hosts readable without advertising hardware support', () => {
    const { encoder: _encoder, encoderName: _encoderName, availableEncoders: _available, ...legacy } = response;
    expect(parseAndroidStreamSource(legacy)).toMatchObject({
      encoder: 'software',
      encoderName: null,
      availableEncoders: ['software'],
    });
  });

  test('rejects invalid encoder fields and malformed availability', () => {
    for (const patch of [
      { encoder: 'nvenc' },
      { encoderName: '' },
      { encoderName: 123 },
      { availableEncoders: [] },
      { availableEncoders: ['hardware'] },
      { availableEncoders: ['software', 'software'] },
      { availableEncoders: ['software', 'nvenc'] },
      { hardwareEncoderError: false },
      { hardwareEncoderError: '' },
    ]) {
      expect(parseAndroidStreamSource({ ...response, ...patch })).toBeNull();
    }
  });
});
