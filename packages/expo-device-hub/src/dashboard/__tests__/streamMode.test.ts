import { describe, expect, test } from 'bun:test';

import { resolveStreamMode, streamModeAvailability } from '../streamMode';

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
});
