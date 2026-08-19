import { afterEach, describe, expect, test } from 'bun:test';

import { resolveStreamMode, streamModeAvailability } from '../streamMode';
import { dashboardStreamMode, parseStreamMode } from '../../stream-mode';

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
    (globalThis as any).window = { __EXPO_DEVICE_HUB_STREAM_MODE__: 'webrtc' };
    const availability = streamModeAvailability({
      secureContext: true,
      h264Decoder: true,
      webRtc: true,
    });
    expect(resolveStreamMode(dashboardStreamMode(), availability)).toBe('webrtc');
  });

  test('falls back to MJPEG when the standalone preference is unavailable', () => {
    (globalThis as any).window = { __EXPO_DEVICE_HUB_STREAM_MODE__: 'h264' };
    const availability = streamModeAvailability({
      secureContext: false,
      h264Decoder: true,
      webRtc: true,
    });
    expect(resolveStreamMode(dashboardStreamMode(), availability)).toBe('mjpeg');
  });
});

describe('parseStreamMode', () => {
  test('accepts only supported stream modes', () => {
    expect(parseStreamMode('mjpeg')).toBe('mjpeg');
    expect(parseStreamMode('h264')).toBe('h264');
    expect(parseStreamMode('webrtc')).toBe('webrtc');
    expect(parseStreamMode('auto')).toBeUndefined();
    expect(parseStreamMode(undefined)).toBeUndefined();
  });
});
