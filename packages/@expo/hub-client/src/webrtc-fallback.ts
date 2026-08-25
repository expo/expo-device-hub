import { type DeviceWebRtcCodec } from './types';

export type WebRtcCodec = DeviceWebRtcCodec;

export type WebRtcFailureReason =
  | { kind: 'permanent' }
  | { kind: 'codec'; codec: WebRtcCodec };

export type WebRtcStreamFailure = WebRtcFailureReason & { sessionId: string };

export type WebRtcFallbackDecision =
  | { type: 'retry-codec'; codec: WebRtcCodec }
  | { type: 'switch-to-http' };

const FALLBACK_ATTEMPTS: Record<WebRtcCodec, readonly WebRtcCodec[]> = {
  h264: ['h264', 'vp8', 'vp9'],
  vp9: ['vp9', 'vp8'],
  vp8: ['vp8'],
};

export function nextWebRtcFallbackCodec(
  requested: WebRtcCodec,
  current: WebRtcCodec,
): WebRtcCodec | null {
  const attempts = FALLBACK_ATTEMPTS[requested];
  const currentIndex = attempts.indexOf(current);
  if (currentIndex === -1) return attempts[0] ?? null;
  return attempts[currentIndex + 1] ?? null;
}

export function webRtcFallbackDecision(
  requested: WebRtcCodec,
  current: WebRtcCodec,
  failure: WebRtcFailureReason,
): WebRtcFallbackDecision | null {
  if (failure.kind === 'permanent') return { type: 'switch-to-http' };
  if (failure.codec !== current) return null;
  const nextCodec = nextWebRtcFallbackCodec(requested, current);
  return nextCodec && nextCodec !== current
    ? { type: 'retry-codec', codec: nextCodec }
    : { type: 'switch-to-http' };
}

export type WebRtcFailureEvent =
  | 'first-frame-timeout'
  | 'connection-failed'
  | 'signaling-failed';

export function webRtcFailureDisposition(
  event: WebRtcFailureEvent,
  connectionState: RTCPeerConnectionState,
): 'codec' | 'transport' {
  return event === 'first-frame-timeout' && connectionState === 'connected'
    ? 'codec'
    : 'transport';
}
