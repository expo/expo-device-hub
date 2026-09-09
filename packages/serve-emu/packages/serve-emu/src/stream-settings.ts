export type WebRtcIceTransportPolicy = "all" | "relay";

export type WebRtcIceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

export const STREAM_TRANSPORTS = ["websocket", "webrtc"] as const;
export type StreamTransport = (typeof STREAM_TRANSPORTS)[number];

export type WebRtcStreamSettings = {
  transport: "webrtc";
  codec: "h264";
  iceServers: WebRtcIceServer[];
  iceTransportPolicy: WebRtcIceTransportPolicy;
};

export type StreamSettings =
  | { transport: "websocket" }
  | WebRtcStreamSettings;

export type ViewerTransports = {
  /** Initial transport selected by clients that have no viewer-local preference. */
  default: StreamTransport;
  /** Video transports supported by the currently active encoded source. */
  available: StreamTransport[];
  /** Signaling profile for WebRTC, or null when the active source is incompatible. */
  webrtc: WebRtcStreamSettings | null;
};

export const DEFAULT_WEBRTC_ICE_SERVERS: WebRtcIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302"] },
  { urls: ["stun:stun1.l.google.com:19302"] },
];

export const DEFAULT_WEBRTC_STREAM_SETTINGS: WebRtcStreamSettings = {
  transport: "webrtc",
  codec: "h264",
  iceServers: DEFAULT_WEBRTC_ICE_SERVERS,
  iceTransportPolicy: "all",
};

export const DEFAULT_STREAM_SETTINGS: StreamSettings = { transport: "websocket" };

/**
 * Describe viewer-local transport choices without turning transport into a
 * device-session mutation. The configured transport remains the default only;
 * both video paths may coexist for different viewers.
 */
export function viewerTransportsFor(
  settings: StreamSettings,
  activeCodec: string,
): ViewerTransports {
  const supportsWebRtc = activeCodec === "h264";
  return {
    default: supportsWebRtc ? settings.transport : "websocket",
    available: supportsWebRtc ? [...STREAM_TRANSPORTS] : ["websocket"],
    webrtc: supportsWebRtc
      ? settings.transport === "webrtc"
        ? settings
        : DEFAULT_WEBRTC_STREAM_SETTINGS
      : null,
  };
}

export type StreamEncoderSettings = {
  maxDimension: number;
  h264Bitrate: number;
  h264Fps: number;
};

export type StreamEncoderSettingsPatch = Partial<StreamEncoderSettings>;

export const MAX_STREAM_DIMENSION = 4_096;
export const MIN_H264_BITRATE = 100_000;
export const MAX_H264_BITRATE = 50_000_000;
export const MAX_H264_FPS = 120;

const STREAM_ENCODER_SETTING_KEYS = new Set<keyof StreamEncoderSettings>([
  "maxDimension",
  "h264Bitrate",
  "h264Fps",
]);

export class InvalidStreamSettingsError extends Error {}

export class StreamSettingsUnavailableError extends Error {}

export function parseStreamEncoderSettingsPatch(
  value: unknown,
): StreamEncoderSettingsPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidStreamSettingsError("stream settings must be an object");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 0) {
    throw new InvalidStreamSettingsError(
      "stream settings patch must not be empty",
    );
  }
  const unknownKey = keys.find(
    (key) =>
      !STREAM_ENCODER_SETTING_KEYS.has(key as keyof StreamEncoderSettings),
  );
  if (unknownKey !== undefined) {
    throw new InvalidStreamSettingsError(
      `unknown stream setting: ${unknownKey}`,
    );
  }

  const readInteger = (
    key: keyof StreamEncoderSettings,
    min: number,
    max: number,
  ) => {
    if (!(key in input)) return undefined;
    const setting = input[key];
    if (
      typeof setting !== "number" ||
      !Number.isFinite(setting) ||
      !Number.isInteger(setting) ||
      setting < min ||
      setting > max
    ) {
      throw new InvalidStreamSettingsError(
        `${key} must be an integer between ${min} and ${max}`,
      );
    }
    return setting;
  };

  const maxDimension = readInteger(
    "maxDimension",
    0,
    MAX_STREAM_DIMENSION,
  );
  const h264Bitrate = readInteger(
    "h264Bitrate",
    MIN_H264_BITRATE,
    MAX_H264_BITRATE,
  );
  const h264Fps = readInteger("h264Fps", 1, MAX_H264_FPS);
  return {
    ...(maxDimension !== undefined ? { maxDimension } : {}),
    ...(h264Bitrate !== undefined ? { h264Bitrate } : {}),
    ...(h264Fps !== undefined ? { h264Fps } : {}),
  };
}

export function streamEncoderSettingsEqual(
  left: StreamEncoderSettings,
  right: StreamEncoderSettings,
): boolean {
  return (
    left.maxDimension === right.maxDimension &&
    left.h264Bitrate === right.h264Bitrate &&
    left.h264Fps === right.h264Fps
  );
}

export function isJsonRequest(req: Request): boolean {
  const contentType = req.headers.get("content-type");
  return (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
  );
}

export function parseIceUrlList(value: string, kind: "stun" | "turn"): string[] {
  const urls = value.split(",").map((url) => url.trim()).filter(Boolean);
  const scheme = kind === "stun" ? /^stuns?:/i : /^turns?:/i;
  if (urls.length === 0 || urls.length > 16 || urls.some((url) => url.length > 2_048 || !scheme.test(url))) {
    throw new Error(`Expected one or more comma-separated ${kind.toUpperCase()} URLs`);
  }
  return urls;
}

export function redactedStreamSettings(settings: StreamSettings): StreamSettings {
  if (settings.transport !== "webrtc") return settings;
  return {
    ...settings,
    iceServers: settings.iceServers.map((server) => ({
      urls: server.urls,
      ...(server.username ? { username: server.username } : {}),
      ...(server.credential ? { credential: "redacted" } : {}),
    })),
  };
}
