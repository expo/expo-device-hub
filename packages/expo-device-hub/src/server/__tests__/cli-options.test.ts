import { describe, expect, test } from 'bun:test';

import { HELP, parseCliOptions } from '../cli/options';

describe('parseCliOptions', () => {
  test('keeps the existing defaults when no options are provided', () => {
    expect(parseCliOptions([])).toEqual({
      port: undefined,
      host: '127.0.0.1',
      platform: undefined,
      transport: undefined,
      hideSidebar: false,
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

  test('hides the device list sidebar on request', () => {
    expect(parseCliOptions(['--hide-sidebar']).hideSidebar).toBe(true);
    expect(HELP).toContain('--hide-sidebar');
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
      hideSidebar: false,
      help: false,
    });
    expect(parseCliOptions(['--help'])).toEqual({ host: '127.0.0.1', help: true });
  });
});
