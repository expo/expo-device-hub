import type { WebRtcStreamCodec } from "../state";

export type WebRtcCodec = WebRtcStreamCodec;

export type WebRtcFailureReason =
  | { kind: "permanent" }
  | { kind: "codec"; codec: WebRtcCodec };

export type WebRtcStreamFailure = WebRtcFailureReason & { sessionId: string };

export type WebRtcFallbackDecision =
  | { type: "retry-codec"; codec: WebRtcCodec }
  | { type: "switch-to-http" };

const FALLBACK_ATTEMPTS: Record<WebRtcCodec, readonly WebRtcCodec[]> = {
  h264: ["h264", "vp8", "vp9"],
  vp9: ["vp9", "vp8"],
  vp8: ["vp8"],
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
  if (failure.kind === "permanent") return { type: "switch-to-http" };
  if (failure.codec !== current) return null;
  const nextCodec = nextWebRtcFallbackCodec(requested, current);
  return nextCodec && nextCodec !== current
    ? { type: "retry-codec", codec: nextCodec }
    : { type: "switch-to-http" };
}

const LADDER_RESTART_BASE_MS = 2_000;
const LADDER_RESTART_MAX_MS = 30_000;

/// Every codec failing at once is usually one cause, and causes outlive a single attempt.
function ladderRestartDelayMs(attempt: number): number {
  const exponent = Math.min(Math.max(attempt, 0), 4);
  return Math.min(LADDER_RESTART_BASE_MS * 2 ** exponent, LADDER_RESTART_MAX_MS);
}

/// Must outlast a restart delay plus a whole walk, or the longest delay looks unrelated and
/// the backoff drops back to the floor forever.
export const LADDER_SETTLED_MS = 90_000;

export interface LadderBackoff {
  noteFailure(now: number): void;
  takeRestartDelayMs(): number;
}

export function createLadderBackoff(): LadderBackoff {
  let attempt = 0;
  let lastFailureAt: number | null = null;
  return {
    noteFailure(now) {
      if (lastFailureAt !== null && now - lastFailureAt >= LADDER_SETTLED_MS) attempt = 0;
      lastFailureAt = now;
    },
    takeRestartDelayMs() { return ladderRestartDelayMs(attempt++); },
  };
}

