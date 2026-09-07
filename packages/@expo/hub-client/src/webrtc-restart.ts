export type WebRtcRestartKey = string | number | null;

export type WebRtcRestartState = {
  key: WebRtcRestartKey;
  generation: number;
};

/** Initial metadata establishes a baseline; later known changes replace the peer. */
export function observeWebRtcRestartKey(
  previous: WebRtcRestartState,
  key: WebRtcRestartKey,
): WebRtcRestartState {
  if (previous.key === key) return previous;
  return {
    key,
    generation: previous.generation + (previous.key !== null && key !== null ? 1 : 0),
  };
}
