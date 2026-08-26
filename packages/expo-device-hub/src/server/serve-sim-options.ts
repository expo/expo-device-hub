import { type StreamSettings, type WebRtcIceServer } from '@expo/serve-sim/state';

import { DEFAULT_WEBRTC_CODEC, type CliOptions } from './cli/options';

export const SERVE_SIM_OPTIONS_ENV = 'EXPO_DEVICE_HUB_SERVE_SIM_OPTIONS';

export type StandaloneServeSimOptions = {
  streamSettings?: StreamSettings;
  metricsCorsOrigins?: string[];
};

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
    ...(streamSettings ? { streamSettings } : {}),
    ...(options.metricsCorsOrigins && options.metricsCorsOrigins.length > 0
      ? { metricsCorsOrigins: options.metricsCorsOrigins }
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
