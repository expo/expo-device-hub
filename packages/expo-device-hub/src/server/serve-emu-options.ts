import {
  DEFAULT_ANDROID_STREAM_SOURCE,
  DEFAULT_GRPC_IMAGE_MODE,
  DEFAULT_WEBRTC_ICE_POLICY,
  type AndroidStreamSource,
  type CliOptions,
  type GrpcImageMode,
  type WebRtcIcePolicy,
} from './cli/options';

export const SERVE_EMU_OPTIONS_ENV = 'EXPO_DEVICE_HUB_SERVE_EMU_OPTIONS';

export type StandaloneServeEmuIceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

export type StandaloneServeEmuStreamSettings =
  | { transport: 'websocket' }
  | {
      transport: 'webrtc';
      codec: 'h264';
      iceServers: StandaloneServeEmuIceServer[];
      iceTransportPolicy: WebRtcIcePolicy;
    };

/** The public STUN defaults used by serve-emu's own standalone CLI. */
export const DEFAULT_SERVE_EMU_ICE_SERVERS: StandaloneServeEmuIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302'] },
  { urls: ['stun:stun1.l.google.com:19302'] },
];

export type StandaloneServeEmuOptions = {
  maxFps?: number;
  bitRate?: number;
  maxSize?: number;
  streamMode?: AndroidStreamSource;
  grpcImageMode?: GrpcImageMode;
  streamSettings: StandaloneServeEmuStreamSettings;
};

function defaultServeEmuOptions(): StandaloneServeEmuOptions {
  return {
    streamMode: DEFAULT_ANDROID_STREAM_SOURCE,
    grpcImageMode: DEFAULT_GRPC_IMAGE_MODE,
    streamSettings: { transport: 'websocket' },
  };
}

function webRtcIceServers(options: CliOptions): StandaloneServeEmuIceServer[] {
  const iceServers: StandaloneServeEmuIceServer[] = options.stunUrls
    ? [{ urls: options.stunUrls }]
    : DEFAULT_SERVE_EMU_ICE_SERVERS.map((server) => ({
        ...server,
        urls: [...server.urls],
      }));
  if (options.turnUrls) {
    iceServers.push({
      urls: options.turnUrls,
      ...(options.turnUsername !== undefined ? { username: options.turnUsername } : {}),
      ...(options.turnCredential !== undefined ? { credential: options.turnCredential } : {}),
    });
  }
  return iceServers;
}

/** Map the Hub's cross-platform CLI flags onto serve-emu's router defaults. */
export function standaloneServeEmuOptions(options: CliOptions): StandaloneServeEmuOptions {
  return {
    ...(options.videoFps !== undefined ? { maxFps: options.videoFps } : {}),
    ...(options.videoBitrate !== undefined ? { bitRate: options.videoBitrate } : {}),
    ...(options.maxDimension !== undefined ? { maxSize: options.maxDimension } : {}),
    streamMode: options.streamSource ?? DEFAULT_ANDROID_STREAM_SOURCE,
    grpcImageMode: options.grpcImageMode ?? DEFAULT_GRPC_IMAGE_MODE,
    streamSettings:
      options.transport === 'webrtc'
        ? {
            transport: 'webrtc',
            // serve-emu publishes the scrcpy H.264 encoder over RTP. The Hub's
            // VP8/VP9 preference remains valid for iOS but cannot be forwarded here.
            codec: 'h264',
            iceServers: webRtcIceServers(options),
            iceTransportPolicy: options.webrtcIcePolicy ?? DEFAULT_WEBRTC_ICE_POLICY,
          }
        : { transport: 'websocket' },
  };
}

export function encodeStandaloneServeEmuOptions(options: CliOptions): string {
  return JSON.stringify(standaloneServeEmuOptions(options));
}

export function readStandaloneServeEmuOptions(
  value: string | undefined,
): StandaloneServeEmuOptions {
  if (!value) return defaultServeEmuOptions();
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...defaultServeEmuOptions(), ...(parsed as Partial<StandaloneServeEmuOptions>) }
      : defaultServeEmuOptions();
  } catch {
    return defaultServeEmuOptions();
  }
}

/** Parse the video-channel flags that the serve-emu router expects at upgrade time. */
export function serveEmuWebSocketOptions(url: URL): { video: boolean; frameMeta: boolean } {
  const video = url.searchParams.get('video') !== '0';
  return {
    video,
    frameMeta: video && url.searchParams.get('frame-meta') === '1',
  };
}
