import { afterEach, describe, expect, test } from 'bun:test';

import {
  resolveStreamMode,
  streamModeAvailability,
  webRtcHttpFallbackMode,
} from '../streamMode';
import { dashboardTransport, parseTransport } from '../../transport';

afterEach(() => {
  delete (globalThis as any).window;
});

describe('stream mode availability', () => {
  test('enables all modes in a capable secure context such as localhost', () => {
    expect(
      streamModeAvailability({ secureContext: true, h264Decoder: true, webRtc: true }),
    ).toEqual({ mjpeg: true, h264: true, webrtc: true });
  });

  test('disables H.264 and WebRTC on insecure LAN HTTP', () => {
    const availability = streamModeAvailability({
      secureContext: false,
      h264Decoder: true,
      webRtc: true,
    });
    expect(availability).toEqual({ mjpeg: true, h264: false, webrtc: false });
    expect(resolveStreamMode('h264', availability)).toBe('mjpeg');
    expect(resolveStreamMode('webrtc', availability)).toBe('mjpeg');
  });

  test('keeps MJPEG available when optional browser APIs are missing', () => {
    const availability = streamModeAvailability({
      secureContext: true,
      h264Decoder: false,
      webRtc: false,
    });
    expect(resolveStreamMode('mjpeg', availability)).toBe('mjpeg');
    expect(resolveStreamMode('h264', availability)).toBe('mjpeg');
  });

  test('uses the standalone host preference when it is available', () => {
    (globalThis as any).window = { __EXPO_DEVICE_HUB_TRANSPORT__: 'webrtc' };
    const availability = streamModeAvailability({
      secureContext: true,
      h264Decoder: true,
      webRtc: true,
    });
    expect(resolveStreamMode(dashboardTransport(), availability)).toBe('webrtc');
  });

  test('falls back to MJPEG when the standalone preference is unavailable', () => {
    (globalThis as any).window = { __EXPO_DEVICE_HUB_TRANSPORT__: 'h264' };
    const availability = streamModeAvailability({
      secureContext: false,
      h264Decoder: true,
      webRtc: true,
    });
    expect(resolveStreamMode(dashboardTransport(), availability)).toBe('mjpeg');
  });

  test('commits only WebRTC transport fallback, preserving direct HTTP codec intent', () => {
    expect(webRtcHttpFallbackMode('webrtc', 'h264')).toBe('h264');
    expect(webRtcHttpFallbackMode('webrtc', 'mjpeg')).toBe('mjpeg');
    expect(webRtcHttpFallbackMode('h264', 'mjpeg')).toBeNull();
    expect(webRtcHttpFallbackMode('mjpeg', 'mjpeg')).toBeNull();
  });
});

describe('parseTransport', () => {
  test('accepts only supported transports', () => {
    expect(parseTransport('mjpeg')).toBe('mjpeg');
    expect(parseTransport('h264')).toBe('h264');
    expect(parseTransport('webrtc')).toBe('webrtc');
    expect(parseTransport('auto')).toBeUndefined();
    expect(parseTransport(undefined)).toBeUndefined();
  });
});
