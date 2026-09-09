import type { StreamSettings, WebRtcIceServer } from "./state";
import { normalizeStreamEncoderSettings } from "./stream-settings";

export function parseIceUrlList(value: string, kind: "stun" | "turn"): string[] {
  const urls = value.split(",").map((url) => url.trim()).filter(Boolean);
  const scheme = kind === "stun" ? /^stuns?:/i : /^turns?:/i;
  if (urls.length === 0 || urls.length > 16 || urls.some((url) => url.length > 2_048 || !scheme.test(url))) {
    throw new Error(`Expected one or more comma-separated ${kind.toUpperCase()} URLs`);
  }
  return urls;
}

export function streamSettingsEqual(
  left: StreamSettings | undefined,
  right: StreamSettings | undefined,
): boolean {
  const normalizedLeft = left ?? { transport: "http" };
  const normalizedRight = right ?? { transport: "http" };
  if (normalizedLeft.transport !== normalizedRight.transport) return false;
  const leftEncoder = normalizeStreamEncoderSettings(normalizedLeft);
  const rightEncoder = normalizeStreamEncoderSettings(normalizedRight);
  if (
    leftEncoder.mjpegFps !== rightEncoder.mjpegFps
    || leftEncoder.mjpegQuality !== rightEncoder.mjpegQuality
    || leftEncoder.maxDimension !== rightEncoder.maxDimension
    || leftEncoder.h264Bitrate !== rightEncoder.h264Bitrate
    || leftEncoder.h264Fps !== rightEncoder.h264Fps
  ) {
    return false;
  }
  if (normalizedLeft.transport === "http" && normalizedRight.transport === "http") {
    return (normalizedLeft.codec ?? "auto") === (normalizedRight.codec ?? "auto");
  }
  if (normalizedLeft.transport !== "webrtc" || normalizedRight.transport !== "webrtc") return false;
  if (normalizedLeft.codec !== normalizedRight.codec) return false;
  const leftServers = normalizedLeft.iceServers ?? [];
  const rightServers = normalizedRight.iceServers ?? [];
  if (leftServers.length !== rightServers.length) return false;
  return leftServers.every((server, index) => {
    const other = rightServers[index]!;
    return server.username === other.username &&
      server.credential === other.credential &&
      server.urls.length === other.urls.length &&
      server.urls.every((url, urlIndex) => url === other.urls[urlIndex]);
  });
}

function urlsWithPrefix(
  servers: WebRtcIceServer[] | undefined,
  prefixes: string[],
): string[] {
  const urls: string[] = [];
  for (const server of servers ?? []) {
    for (const url of server.urls) {
      const lower = url.toLowerCase();
      if (prefixes.some((prefix) => lower.startsWith(prefix))) urls.push(url);
    }
  }
  return urls;
}

function firstTurnServer(
  servers: WebRtcIceServer[] | undefined,
): WebRtcIceServer | null {
  for (const server of servers ?? []) {
    if (server.urls.some((url) => /^turns?:/i.test(url))) return server;
  }
  return null;
}

export function streamRuntimeArgs(settings?: StreamSettings): string[] {
  if (!settings) return [];

  const args: string[] = [];
  args.push("--transport", settings.transport);
  if (settings.transport === "http") {
    if (settings.codec) args.push("--codec", settings.codec);
  } else {
    args.push("--webrtc-codec", settings.codec);

    const stunUrls = urlsWithPrefix(settings.iceServers, ["stun:", "stuns:"]);
    if (stunUrls.length) args.push("--stun-url", stunUrls.join(","));

    const turnUrls = urlsWithPrefix(settings.iceServers, ["turn:", "turns:"]);
    if (turnUrls.length) {
      args.push("--turn-url", turnUrls.join(","));
      const turnServer = firstTurnServer(settings.iceServers);
      if (turnServer?.username) args.push("--turn-username", turnServer.username);
      if (turnServer?.credential) args.push("--turn-credential", turnServer.credential);
    }
  }

  if (settings.mjpegFps !== undefined) args.push("--mjpeg-fps", String(settings.mjpegFps));
  if (settings.mjpegQuality !== undefined) args.push("--mjpeg-quality", String(settings.mjpegQuality));
  if (settings.maxDimension !== undefined) args.push("--max-dimension", String(settings.maxDimension));
  if (settings.h264Bitrate !== undefined) args.push("--video-bitrate", String(settings.h264Bitrate));
  if (settings.h264Fps !== undefined) args.push("--video-fps", String(settings.h264Fps));

  return args;
}

export function streamHelperArgs(
  udid: string,
  port: number,
  host: string,
  settings?: StreamSettings,
): string[] {
  return [
    udid,
    "--port",
    String(port),
    "--host",
    host,
    ...streamRuntimeArgs(settings),
  ];
}
