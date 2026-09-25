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

/// Whether a rejected offer is worth trying again. The signalling path 404s while a helper
/// restarts or a reaped session's route comes back, and that resolves on its own. A refused
/// or malformed request never will, and retrying one only hides it.
export function offerFailureIsTransient(status: number): boolean {
  if (status >= 500) return true;
  return status === 404 || status === 408 || status === 425 || status === 429;
}
