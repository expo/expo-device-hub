export const MAX_WEBRTC_SIGNALING_BODY_BYTES = 256 * 1024;

export type WebRtcOffer = {
  type: "offer";
  sdp: string;
  sessionId: string;
  codec?: "h264";
};

export type WebRtcAnswer = {
  type: string;
  sdp: string;
};

export type WebRtcCloseRequest = {
  sessionId: string;
};

export class WebRtcSignalingError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "WebRtcSignalingError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSessionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new WebRtcSignalingError("Invalid WebRTC session ID", 400, "invalid_session_id");
  }
  return value;
}

export function parseWebRtcOffer(value: unknown): WebRtcOffer {
  if (!isRecord(value) || value.type !== "offer") {
    throw new WebRtcSignalingError("Expected a WebRTC offer", 400, "invalid_offer");
  }
  if (typeof value.sdp !== "string" || value.sdp.length === 0 || value.sdp.length > 240 * 1024) {
    throw new WebRtcSignalingError("Invalid WebRTC offer SDP", 400, "invalid_offer");
  }
  if (value.codec !== undefined && value.codec !== "h264") {
    throw new WebRtcSignalingError("serve-emu WebRTC currently supports only H.264", 400, "invalid_offer");
  }
  if (value.iceServers !== undefined) {
    throw new WebRtcSignalingError(
      "ICE servers must be configured by the serve-emu host",
      400,
      "client_ice_servers_unsupported",
    );
  }
  return {
    type: "offer",
    sdp: value.sdp,
    sessionId: requireSessionId(value.sessionId),
    ...(value.codec !== undefined ? { codec: "h264" as const } : {}),
  };
}

export function parseWebRtcCloseRequest(value: unknown): WebRtcCloseRequest {
  if (!isRecord(value)) {
    throw new WebRtcSignalingError("Invalid WebRTC close request", 400, "invalid_close_request");
  }
  return { sessionId: requireSessionId(value.sessionId) };
}

export function parseWebRtcStatsSessionId(value: string | null): string {
  if (value === null || value === "") {
    throw new WebRtcSignalingError(
      "WebRTC session ID is required",
      400,
      "missing_session_id",
    );
  }
  return requireSessionId(value);
}
