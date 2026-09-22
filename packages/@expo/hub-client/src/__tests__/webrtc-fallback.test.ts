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
    expect(webRtcFailureDisposition('signaling-failed', 'new')).toBe('transport');
  });

  test('keeps waiting when media is arriving but has not rendered yet', () => {
    // A large first keyframe can arrive inside the connection and still paint
    // after the deadline; downgrading the codec there throws away a working
    // stream (serve-sim #161).
    expect(
      webRtcFailureDisposition('first-frame-timeout', 'connected', { mediaArriving: true }),
    ).toBe('wait');
  });

  test('still blames the codec when nothing at all is arriving', () => {
    expect(
      webRtcFailureDisposition('first-frame-timeout', 'connected', { mediaArriving: false }),
    ).toBe('codec');
  });
});
