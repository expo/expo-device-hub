export type WebRtcFailureEvent =
  | "first-frame-timeout"
  | "connection-failed"
  | "signaling-failed";

/// "wait" means the deadline passed but media is arriving, so the caller should re-arm.
export type WebRtcFailureDisposition = "codec" | "transport" | "wait";

export interface WebRtcMediaProgress {
  mediaArriving: boolean;
}

/// A first-frame timeout only indicts the codec when nothing is arriving at all.
///
/// The watchdog is cleared by the browser *painting*, which also waits on the video element
/// being attached. Received RTP is the narrower question — it proves the codec produced
/// something the transport accepted — so when media is flowing, keep waiting rather than
/// walking the fallback ladder and downgrading a working stream.
export function webRtcFailureDisposition(
  event: WebRtcFailureEvent,
  connectionState: RTCPeerConnectionState,
  progress: WebRtcMediaProgress = { mediaArriving: false },
): WebRtcFailureDisposition {
  if (event !== "first-frame-timeout" || connectionState !== "connected") return "transport";
  return progress.mediaArriving ? "wait" : "codec";
}
