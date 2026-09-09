export type HttpStreamCodec = "auto" | "mjpeg" | "h264";
export type WebRtcStreamCodec = "vp8" | "vp9" | "h264";
export type WebRtcIceServer = { urls: string[]; username?: string; credential?: string };

export const MAX_MJPEG_STREAM_FPS = 120;
export const MAX_VIDEO_STREAM_FPS = 140;

export type StreamSettings = (
  | { transport: "http"; codec?: HttpStreamCodec }
  | { transport: "webrtc"; codec: WebRtcStreamCodec; iceServers?: WebRtcIceServer[] }
) & Partial<StreamEncoderSettings>;

export interface StreamPlaybackSettings {
  transport: "http" | "webrtc";
  httpCodec: HttpStreamCodec;
  webRtcCodec: WebRtcStreamCodec;
  iceServers?: WebRtcIceServer[];
}

export interface StreamEncoderSettings {
  mjpegFps: number;
  mjpegQuality: number;
  maxDimension: number;
  /** Shared target bitrate for H.264/AVCC and WebRTC video. */
  h264Bitrate: number;
  /** Shared target frame rate for H.264/AVCC and WebRTC video. */
  h264Fps: number;
}

export type StreamControlSettings = StreamPlaybackSettings & StreamEncoderSettings;

export const DEFAULT_STREAM_ENCODER_SETTINGS: StreamEncoderSettings = {
  mjpegFps: 60,
  mjpegQuality: 0.7,
  maxDimension: 0,
  h264Bitrate: 6_000_000,
  h264Fps: 60,
};

export const DEFAULT_STREAM_CONTROL_SETTINGS: StreamControlSettings = {
  transport: "http",
  httpCodec: "auto",
  webRtcCodec: "h264",
  ...DEFAULT_STREAM_ENCODER_SETTINGS,
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const number = finiteNumber(value);
  return number == null ? fallback : Math.min(max, Math.max(min, number));
}

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(numberInRange(value, fallback, min, max));
}

/** Invalid input returns null; an empty array is a valid explicit clear. */
function normalizedIceServers(value: unknown): WebRtcIceServer[] | null {
  if (!Array.isArray(value) || value.length > 16) return null;
  const servers: WebRtcIceServer[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const urls = (entry as { urls?: unknown }).urls;
    if (
      !Array.isArray(urls)
      || urls.length === 0
      || urls.length > 16
      || !urls.every((url) =>
        typeof url === "string"
        && url.length <= 2_048
        && /^(stun|stuns|turn|turns):/i.test(url)
      )
    ) {
      return null;
    }
    const username = (entry as { username?: unknown }).username;
    const credential = (entry as { credential?: unknown }).credential;
    if (username !== undefined && typeof username !== "string") return null;
    if (credential !== undefined && typeof credential !== "string") return null;
    servers.push({
      urls,
      ...(typeof username === "string" ? { username } : {}),
      ...(typeof credential === "string" ? { credential } : {}),
    });
  }
  return servers;
}

const STREAM_ENCODER_SETTING_KEYS = new Set<keyof StreamEncoderSettings>([
  "mjpegFps",
  "mjpegQuality",
  "maxDimension",
  "h264Bitrate",
  "h264Fps",
]);

const WEBRTC_ENCODER_SETTING_KEYS = new Set<keyof StreamEncoderSettings>([
  "maxDimension",
  "h264Bitrate",
  "h264Fps",
]);

/** Validate an untrusted PATCH body without silently accepting typos or wrong types. */
export function parseStreamEncoderSettingsPatch(
  input: unknown,
  transport?: StreamPlaybackSettings["transport"],
): Partial<StreamEncoderSettings> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const patch = input as Record<string, unknown>;
  const keys = Object.keys(patch);
  const allowedKeys = transport === "webrtc"
    ? WEBRTC_ENCODER_SETTING_KEYS
    : STREAM_ENCODER_SETTING_KEYS;
  if (
    keys.length === 0
    || keys.some((key) => !allowedKeys.has(key as keyof StreamEncoderSettings))
  ) {
    return null;
  }
  for (const key of ["mjpegFps", "mjpegQuality", "maxDimension", "h264Bitrate", "h264Fps"] as const) {
    if (key in patch && finiteNumber(patch[key]) == null) return null;
  }
  return patch as Partial<StreamEncoderSettings>;
}

export function normalizeStreamControlSettings(
  input: Partial<StreamControlSettings> = {},
  fallback: StreamControlSettings = DEFAULT_STREAM_CONTROL_SETTINGS,
): StreamControlSettings {
  const hasIceServers = Object.prototype.hasOwnProperty.call(input, "iceServers");
  const normalized = hasIceServers ? normalizedIceServers(input.iceServers) : fallback.iceServers;
  const iceServers = normalized === null
    ? fallback.iceServers
    : normalized && normalized.length > 0 ? normalized : undefined;
  return {
    transport: input.transport === "http" || input.transport === "webrtc"
      ? input.transport
      : fallback.transport,
    httpCodec: input.httpCodec === "auto" || input.httpCodec === "mjpeg" || input.httpCodec === "h264"
      ? input.httpCodec
      : fallback.httpCodec,
    webRtcCodec: input.webRtcCodec === "vp8" || input.webRtcCodec === "vp9" || input.webRtcCodec === "h264"
      ? input.webRtcCodec
      : fallback.webRtcCodec,
    ...(iceServers ? { iceServers } : {}),
    ...normalizeStreamEncoderSettings(input, fallback),
  };
}

export function normalizeStreamEncoderSettings(
  input: Partial<StreamEncoderSettings> = {},
  fallback: StreamEncoderSettings = DEFAULT_STREAM_ENCODER_SETTINGS,
): StreamEncoderSettings {
  return {
    mjpegFps: integerInRange(input.mjpegFps, fallback.mjpegFps, 1, MAX_MJPEG_STREAM_FPS),
    mjpegQuality: numberInRange(input.mjpegQuality, fallback.mjpegQuality, 0.05, 1),
    maxDimension: integerInRange(input.maxDimension, fallback.maxDimension, 0, 4096),
    h264Bitrate: integerInRange(input.h264Bitrate, fallback.h264Bitrate, 100_000, 50_000_000),
    h264Fps: integerInRange(input.h264Fps, fallback.h264Fps, 1, MAX_VIDEO_STREAM_FPS),
  };
}

export function streamEncoderSettingsFrom(
  settings: StreamControlSettings,
): StreamEncoderSettings {
  return {
    mjpegFps: settings.mjpegFps,
    mjpegQuality: settings.mjpegQuality,
    maxDimension: settings.maxDimension,
    h264Bitrate: settings.h264Bitrate,
    h264Fps: settings.h264Fps,
  };
}

export function streamEncoderSettingsForTransport(
  settings: StreamEncoderSettings,
  transport: StreamPlaybackSettings["transport"],
): Partial<StreamEncoderSettings> {
  if (transport === "webrtc") {
    return {
      maxDimension: settings.maxDimension,
      h264Bitrate: settings.h264Bitrate,
      h264Fps: settings.h264Fps,
    };
  }
  return {
    mjpegFps: settings.mjpegFps,
    mjpegQuality: settings.mjpegQuality,
    maxDimension: settings.maxDimension,
    h264Bitrate: settings.h264Bitrate,
    h264Fps: settings.h264Fps,
  };
}

export function isWebRtcTransportLocked(settings: StreamSettings | undefined): boolean {
  return settings?.transport === "webrtc";
}

export function streamControlSettingsFrom(
  settings: StreamSettings | undefined,
): StreamControlSettings {
  const encoderSettings = settings
    ? {
        mjpegFps: settings.mjpegFps,
        mjpegQuality: settings.mjpegQuality,
        maxDimension: settings.maxDimension,
        h264Bitrate: settings.h264Bitrate,
        h264Fps: settings.h264Fps,
      }
    : {};
  if (settings?.transport === "webrtc") {
    return normalizeStreamControlSettings({
      transport: "webrtc",
      webRtcCodec: settings.codec,
      iceServers: settings.iceServers,
      ...encoderSettings,
    });
  }
  return normalizeStreamControlSettings({
    transport: "http",
    httpCodec: settings?.codec ?? "auto",
    ...encoderSettings,
  });
}

export function mergeStreamControlSettings(
  current: StreamControlSettings,
  patch: Partial<StreamControlSettings>,
): StreamControlSettings {
  return normalizeStreamControlSettings({ ...current, ...patch }, current);
}

export function mergeStreamPlaybackSettings(
  current: StreamControlSettings,
  patch: Partial<StreamPlaybackSettings>,
  transportLocked = false,
): StreamControlSettings {
  if (!transportLocked) return mergeStreamControlSettings(current, patch);

  const lockedPatch: Partial<StreamPlaybackSettings> = {};
  if (patch.webRtcCodec !== undefined) lockedPatch.webRtcCodec = patch.webRtcCodec;
  if (patch.iceServers !== undefined) lockedPatch.iceServers = patch.iceServers;
  if (Object.keys(lockedPatch).length === 0) return current;

  return mergeStreamControlSettings(current, {
    ...lockedPatch,
    transport: "webrtc",
  });
}

/** Apply shared encoder controls without replacing viewer-local playback values. */
export function mergeStreamEncoderSettings(
  current: StreamControlSettings,
  patch: Partial<StreamEncoderSettings>,
): StreamControlSettings {
  const previous = streamEncoderSettingsFrom(current);
  const next = normalizeStreamEncoderSettings({ ...previous, ...patch }, previous);
  if (
    next.mjpegFps === previous.mjpegFps
    && next.mjpegQuality === previous.mjpegQuality
    && next.maxDimension === previous.maxDimension
    && next.h264Bitrate === previous.h264Bitrate
    && next.h264Fps === previous.h264Fps
  ) {
    return current;
  }
  return { ...current, ...next };
}
