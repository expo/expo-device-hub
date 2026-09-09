import type { WebRtcIceServer, WebRtcStreamCodec } from "./state";

export const MAX_WEBRTC_SIGNALING_BODY_BYTES = 256 * 1024;

export type WebRtcOffer = {
  type: "offer";
  sdp: string;
  sessionId: string;
  codec?: WebRtcStreamCodec;
  iceServers?: WebRtcIceServer[];
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

function optionalBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new WebRtcSignalingError(`Invalid ${field}`, 400, "invalid_offer");
  }
  return value;
}

function parseIceServers(value: unknown): WebRtcIceServer[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16) {
    throw new WebRtcSignalingError("Invalid ICE servers", 400, "invalid_offer");
  }

  return value.map((candidate) => {
    if (!isRecord(candidate) || !Array.isArray(candidate.urls) || candidate.urls.length === 0 || candidate.urls.length > 16) {
      throw new WebRtcSignalingError("Invalid ICE server", 400, "invalid_offer");
    }
    const urls = candidate.urls.map((url) => {
      if (
        typeof url !== "string" ||
        url.length === 0 ||
        url.length > 2_048 ||
        !/^(stun|stuns|turn|turns):/i.test(url)
      ) {
        throw new WebRtcSignalingError("Invalid ICE server URL", 400, "invalid_offer");
      }
      return url;
    });
    const username = optionalBoundedString(candidate.username, "ICE username", 1_024);
    const credential = optionalBoundedString(candidate.credential, "ICE credential", 1_024);
    return {
      urls,
      ...(username !== undefined ? { username } : {}),
      ...(credential !== undefined ? { credential } : {}),
    };
  });
}

export function parseWebRtcOffer(value: unknown): WebRtcOffer {
  if (!isRecord(value) || value.type !== "offer") {
    throw new WebRtcSignalingError("Expected a WebRTC offer", 400, "invalid_offer");
  }
  if (typeof value.sdp !== "string" || value.sdp.length === 0 || value.sdp.length > 240 * 1024) {
    throw new WebRtcSignalingError("Invalid WebRTC offer SDP", 400, "invalid_offer");
  }
  const codec = value.codec;
  if (codec !== undefined && codec !== "vp8" && codec !== "vp9" && codec !== "h264") {
    throw new WebRtcSignalingError("Invalid WebRTC codec", 400, "invalid_offer");
  }
  return {
    type: "offer",
    sdp: value.sdp,
    sessionId: requireSessionId(value.sessionId),
    ...(codec !== undefined ? { codec } : {}),
    ...(value.iceServers !== undefined ? { iceServers: parseIceServers(value.iceServers) } : {}),
  };
}

export function parseWebRtcCloseRequest(value: unknown): WebRtcCloseRequest {
  if (!isRecord(value)) {
    throw new WebRtcSignalingError("Invalid WebRTC close request", 400, "invalid_close_request");
  }
  return { sessionId: requireSessionId(value.sessionId) };
}

export function parseWebRtcStatsSessionId(value: string | null): string | undefined {
  if (value === null || value === "") return undefined;
  return requireSessionId(value);
}
