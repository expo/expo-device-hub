import type { WebRtcIceServer } from "../state";

export type IceServer = WebRtcIceServer;

// Keep ICE in normal mode: direct host/srflx candidates are preferred when they
// work, and TURN is only used when those checks fail. A tunnel URL is signaling
// only; forcing media through a network relay requires a real TURN server plus
// `iceTransportPolicy: "relay"`, which we do not enable by default.
export const WEBRTC_ICE_TRANSPORT_POLICY = "all" satisfies RTCIceTransportPolicy;
