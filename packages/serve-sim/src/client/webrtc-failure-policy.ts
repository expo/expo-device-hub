export type WebRtcFailureEvent =
  | "first-frame-timeout"
  | "connection-failed"
  | "signaling-failed";

export type WebRtcFailureDisposition = "codec" | "transport";

export function webRtcFailureDisposition(
  event: WebRtcFailureEvent,
  connectionState: RTCPeerConnectionState,
): WebRtcFailureDisposition {
  return event === "first-frame-timeout" && connectionState === "connected"
    ? "codec"
    : "transport";
}
