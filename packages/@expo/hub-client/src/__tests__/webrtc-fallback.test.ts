import { describe, expect, test } from 'bun:test';

import {
  nextWebRtcFallbackCodec,
  webRtcFailureDisposition,
  webRtcFallbackDecision,
} from '../webrtc-fallback';

describe('WebRTC fallback', () => {
  test('tries VP8 and VP9 after H.264', () => {
    expect(nextWebRtcFallbackCodec('h264', 'h264')).toBe('vp8');
    expect(nextWebRtcFallbackCodec('h264', 'vp8')).toBe('vp9');
    expect(nextWebRtcFallbackCodec('h264', 'vp9')).toBe(null);
  });

  test('keeps fallback ordering anchored to the configured codec', () => {
    expect(nextWebRtcFallbackCodec('vp8', 'vp8')).toBe(null);
    expect(nextWebRtcFallbackCodec('vp9', 'vp9')).toBe('vp8');
    expect(nextWebRtcFallbackCodec('vp9', 'vp8')).toBe(null);
  });

  test('switches to HTTP after codecs are exhausted or signaling is permanent', () => {
    expect(webRtcFallbackDecision('h264', 'h264', { kind: 'permanent' })).toEqual({
      type: 'switch-to-http',
    });
    expect(webRtcFallbackDecision('h264', 'vp9', { kind: 'codec', codec: 'vp9' })).toEqual({
      type: 'switch-to-http',
    });
  });

  test('only treats a connected first-frame timeout as a codec failure', () => {
    expect(webRtcFailureDisposition('first-frame-timeout', 'connected')).toBe('codec');
    expect(webRtcFailureDisposition('first-frame-timeout', 'connecting')).toBe('transport');
    expect(webRtcFailureDisposition('connection-failed', 'failed')).toBe('transport');
  });
});
