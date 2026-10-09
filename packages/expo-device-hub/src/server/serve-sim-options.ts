import { type StreamSettings, type WebRtcIceServer } from '@expo/serve-sim/state';

import { DEFAULT_WEBRTC_CODEC, type CliOptions } from './cli/options';
import { originMatches } from './origin-match';

export const SERVE_SIM_OPTIONS_ENV = 'EXPO_DEVICE_HUB_SERVE_SIM_OPTIONS';

export type StandaloneServeSimOptions = {
  streamSettings?: StreamSettings;
  metricsCorsOrigins?: string[];
  /** `--cors-origin`: pages that may call serve-sim. Only these, not loopback, may use its control socket. */
  corsOrigins?: string[];
  /** Without the session token, serve-sim allows network capture only on a loopback host. */
  loopbackOnly?: boolean;
};

// The same rule as serve-sim's own: a name such as `127.example.com` is not loopback.
function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
}

/** serve-sim's CORS rule: a page on a loopback host or on a `--cors-origin` origin. */
export function serveSimAllowsOrigin(corsOrigins: readonly string[], origin: URL): boolean {
  return isLoopbackHost(origin.hostname) || corsOrigins.some((allowed) => originMatches(allowed, origin));
}

function streamSettingsFor(options: CliOptions): StreamSettings | undefined {
  const encoderSettings = {
    ...(options.maxDimension !== undefined ? { maxDimension: options.maxDimension } : {}),
    ...(options.mjpegQuality !== undefined ? { mjpegQuality: options.mjpegQuality } : {}),
    ...(options.videoBitrate !== undefined ? { h264Bitrate: options.videoBitrate } : {}),
    ...(options.videoFps !== undefined ? { h264Fps: options.videoFps } : {}),
  };
  const hasEncoderSettings = Object.keys(encoderSettings).length > 0;

  if (options.transport === 'webrtc') {
    const iceServers: WebRtcIceServer[] = [];
    if (options.stunUrls) iceServers.push({ urls: options.stunUrls });
    if (options.turnUrls) {
      iceServers.push({
        urls: options.turnUrls,
        ...(options.turnUsername !== undefined ? { username: options.turnUsername } : {}),
        ...(options.turnCredential !== undefined ? { credential: options.turnCredential } : {}),
      });
    }
    return {
      transport: 'webrtc',
      codec: options.webrtcCodec ?? DEFAULT_WEBRTC_CODEC,
      ...(iceServers.length > 0 ? { iceServers } : {}),
      ...encoderSettings,
    };
  }

  if (options.transport === 'mjpeg' || options.transport === 'h264') {
    return { transport: 'http', codec: options.transport, ...encoderSettings };
  }

  return hasEncoderSettings ? { transport: 'http', ...encoderSettings } : undefined;
}

export function standaloneServeSimOptions(options: CliOptions): StandaloneServeSimOptions {
  const streamSettings = streamSettingsFor(options);
  return {
    loopbackOnly: isLoopbackHost(options.host),
    ...(streamSettings ? { streamSettings } : {}),
    ...(options.metricsCorsOrigins && options.metricsCorsOrigins.length > 0
      ? { metricsCorsOrigins: options.metricsCorsOrigins }
      : {}),
    ...(options.corsOrigins && options.corsOrigins.length > 0
      ? { corsOrigins: options.corsOrigins }
      : {}),
  };
}

export function encodeStandaloneServeSimOptions(options: CliOptions): string {
  return JSON.stringify(standaloneServeSimOptions(options));
}

export function readStandaloneServeSimOptions(
  value: string | undefined,
): StandaloneServeSimOptions {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as StandaloneServeSimOptions)
      : {};
  } catch {
    return {};
  }
}
