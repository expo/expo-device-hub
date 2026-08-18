import { describe, expect, test } from 'bun:test';

import { parseCliOptions } from '../cli/options';

describe('parseCliOptions', () => {
  test('keeps the existing defaults when no options are provided', () => {
    expect(parseCliOptions([])).toEqual({
      port: undefined,
      host: '127.0.0.1',
      platform: undefined,
      streamMode: undefined,
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

  test('accepts each supported stream mode', () => {
    expect(parseCliOptions(['--stream-mode', 'mjpeg']).streamMode).toBe('mjpeg');
    expect(parseCliOptions(['--stream-mode=h264']).streamMode).toBe('h264');
    expect(parseCliOptions(['--stream-mode', 'webrtc']).streamMode).toBe('webrtc');
  });

  test('rejects unsupported stream modes', () => {
    expect(() => parseCliOptions(['--stream-mode', 'auto'])).toThrow(
      'Invalid --stream-mode: auto'
    );
  });

  test('parses the existing host, port, and help options', () => {
    expect(parseCliOptions(['--host', '0.0.0.0', '-p', '4300'])).toEqual({
      port: 4300,
      host: '0.0.0.0',
      platform: undefined,
      streamMode: undefined,
      help: false,
    });
    expect(parseCliOptions(['--help'])).toEqual({ host: '127.0.0.1', help: true });
  });
});
