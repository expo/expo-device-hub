import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_STREAM_MODE,
  initialStreamMode,
  supportsSecureStreamModes,
} from '../streamMode';

function supports(protocol: string, hostname: string, isSecureContext = false): boolean {
  return supportsSecureStreamModes({ protocol, hostname, isSecureContext });
}

describe('stream mode availability', () => {
  test('keeps H.264 as the Hub default on supported origins', () => {
    expect(DEFAULT_STREAM_MODE).toBe('h264');
    expect(initialStreamMode(true)).toBe('h264');
  });

  test('allows local HTTP development', () => {
    expect(supports('http:', 'localhost')).toBe(true);
    expect(supports('http:', 'dev.localhost')).toBe(true);
    expect(supports('http:', '127.0.0.1')).toBe(true);
    expect(supports('http:', '[::1]')).toBe(true);
  });

  test('allows secure contexts and HTTPS', () => {
    expect(supports('http:', 'device.test', true)).toBe(true);
    expect(supports('https:', 'device.test')).toBe(true);
  });

  test('uses MJPEG and disables secure modes on insecure LAN origins', () => {
    expect(supports('http:', '192.168.1.25')).toBe(false);
    expect(initialStreamMode(false)).toBe('mjpeg');
  });
});
