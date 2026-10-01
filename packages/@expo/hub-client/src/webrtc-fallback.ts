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
  | { type: 'restart-ladder'; codec: WebRtcCodec }
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
  transportLocked = false,
): WebRtcFallbackDecision | null {
  if (failure.kind === 'permanent') return transportLocked ? null : { type: 'switch-to-http' };
  if (failure.codec !== current) return null;
  const nextCodec = nextWebRtcFallbackCodec(requested, current);
  return nextCodec && nextCodec !== current
    ? { type: 'retry-codec', codec: nextCodec }
    : transportLocked ? { type: 'restart-ladder', codec: requested } : { type: 'switch-to-http' };
}

/** Codec walks from a persistent outage retain their backoff until the stream settles. */
export function createLadderBackoff() {
  let attempt = 0;
  let lastFailureAt: number | null = null;
  return {
    noteFailure(now: number) {
      if (lastFailureAt !== null && now - lastFailureAt >= 90_000) attempt = 0;
      lastFailureAt = now;
    },
    takeRestartDelayMs() { return Math.min(2_000 * 2 ** Math.min(attempt++, 4), 30_000); },
  };
}

export type WebRtcFailureEvent =
  | "first-frame-timeout"
  | "playback-stall"
  | "connection-failed"
  | "signaling-failed";

/// "wait" means the deadline passed but media is arriving, so the caller should re-arm.
export type WebRtcFailureDisposition = "codec" | "transport" | "wait";

export interface WebRtcMediaProgress {
  mediaArriving: boolean;
  /// Null when the sender could not be asked; only it can tell a dead path from a dead encoder.
  senderEncoding?: boolean | null;
}

/// Before the first frame, arriving media means be patient. After it, frames that arrive and
/// stop being decoded mean the decoder gave up, and waiting cannot fix that.
export function webRtcFailureDisposition(
  event: WebRtcFailureEvent,
  connectionState: RTCPeerConnectionState,
  progress: WebRtcMediaProgress = { mediaArriving: false },
): WebRtcFailureDisposition {
  if (connectionState !== "connected") return "transport";
  if (event === "first-frame-timeout") {
    if (progress.mediaArriving) return "wait";
    // Unknown stays "codec": only a sender known to be encoding redirects the blame.
    return progress.senderEncoding === true ? "transport" : "codec";
  }
  if (event === "playback-stall") return progress.mediaArriving ? "codec" : "transport";
  return "transport";
}

/// How long a same-codec reconnect counts against the codec. Past this the next stall is a
/// separate incident, not the same one continuing, and earns its own reconnect.
export const STALL_RECONNECT_TTL_MS = 30_000;

/// The codec gets a reconnect before it is blamed, or one bad run of frames costs hardware
/// H.264 for the session. Elapsed time rather than a flag, so two unrelated stalls hours
/// apart do not add up to a demotion.
export function playbackStallAction(
  disposition: WebRtcFailureDisposition,
  msSinceCodecReconnect: number | null,
): "retry-transport" | "fail-codec" | "none" {
  if (disposition === "transport") return "retry-transport";
  if (disposition !== "codec") return "none";
  if (msSinceCodecReconnect === null) return "retry-transport";
  return msSinceCodecReconnect < STALL_RECONNECT_TTL_MS ? "fail-codec" : "retry-transport";
}

