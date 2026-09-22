/**
 * WebRTC codec/transport fallback policy, ported from serve-sim's
 * `webrtc-codec-fallback.ts` and `webrtc-failure-policy.ts`.
 */

export type WebRtcCodec = 'h264' | 'vp8' | 'vp9';

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

/** `wait` means the deadline passed but media is arriving, so the caller should re-arm. */
export type WebRtcFailureDisposition = 'codec' | 'transport' | 'wait';

export interface WebRtcMediaProgress {
  mediaArriving: boolean;
}

/**
 * A first-frame timeout only indicts the codec when nothing is arriving at all.
 *
 * The watchdog is cleared by the browser *painting*, which also waits on the
 * video element being attached. Received RTP is the narrower question — it
 * proves the codec produced something the transport accepted — so when media
 * is flowing, keep waiting rather than walking the fallback ladder and
 * downgrading a working stream (serve-sim #161).
 */
export function webRtcFailureDisposition(
  event: WebRtcFailureEvent,
  connectionState: RTCPeerConnectionState,
  progress: WebRtcMediaProgress = { mediaArriving: false },
): WebRtcFailureDisposition {
  if (event !== 'first-frame-timeout' || connectionState !== 'connected') return 'transport';
  return progress.mediaArriving ? 'wait' : 'codec';
}
