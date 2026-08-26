import { parseArgs } from 'node:util';

import { type WebRtcStreamCodec } from '@expo/serve-sim/state';

import { parsePlatformFilter, type PlatformFilter } from '../../platform-filter';
import {
  DEFAULT_TRANSPORT,
  parseTransport,
  TRANSPORTS,
  type Transport,
} from '../../transport';

export const DEFAULT_PORT = 3400;
export const DEFAULT_WEBRTC_CODEC: WebRtcStreamCodec = 'h264';
export const WEBRTC_CODECS = ['vp8', 'vp9', 'h264'] as const satisfies readonly WebRtcStreamCodec[];

export const HELP = `expo-device-hub — manage iOS simulators and Android emulators from the browser

Usage: expo-device-hub [options]

Options:
  -p, --port <port>          Port to listen on (default: ${DEFAULT_PORT}, or the next available port)
      --host <host>          Host to bind (default: 127.0.0.1; use 0.0.0.0 to expose on your local network)
      --platform <platform>  Show only iOS simulators or Android emulators (ios or android)
      --transport <transport> Preferred transport: ${TRANSPORTS.join(', ')} (default: ${DEFAULT_TRANSPORT})
      --webrtc-codec <codec> WebRTC video codec: ${WEBRTC_CODECS.join(', ')} (default: ${DEFAULT_WEBRTC_CODEC})
      --max-dimension <pixels> Maximum captured width or height; 0 keeps native resolution (0-4096)
      --mjpeg-quality <quality> MJPEG quality (0.05-1)
      --video-bitrate <bps>  H.264/WebRTC target bitrate (100000-50000000)
      --video-fps <fps>      H.264/WebRTC frame rate (1-120)
      --stun-url <urls>      Comma-separated STUN URL(s) for WebRTC ICE
      --turn-url <urls>      Comma-separated TURN URL(s) for WebRTC ICE
      --turn-username <name> TURN username (requires --turn-credential and --turn-url)
      --turn-credential <credential> TURN credential (requires --turn-username and --turn-url)
      --metrics-cors-origin <origin> Allow an origin to read serve-sim metrics (repeatable)
      --hide-sidebar         Hide the device list sidebar by default
  -h, --help                 Show this help
`;

export type CliOptions = {
  port?: number;
  host: string;
  platform?: PlatformFilter;
  transport?: Transport;
  webrtcCodec?: WebRtcStreamCodec;
  maxDimension?: number;
  mjpegQuality?: number;
  videoBitrate?: number;
  videoFps?: number;
  stunUrls?: string[];
  turnUrls?: string[];
  turnUsername?: string;
  turnCredential?: string;
  metricsCorsOrigins?: string[];
  hideSidebar?: boolean;
  help: boolean;
};

function parseNumberOption(
  value: string | undefined,
  option: string,
  min: number,
  max: number,
  integer = false
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    (integer && !Number.isInteger(parsed)) ||
    parsed < min ||
    parsed > max
  ) {
    const kind = integer ? 'integer' : 'number';
    throw new Error(
      `Invalid ${option}: ${value} (expected a ${kind} from ${min} to ${max})\n\n${HELP}`
    );
  }
  return parsed;
}

function parseIceUrls(
  value: string | undefined,
  kind: 'stun' | 'turn'
): string[] | undefined {
  if (value === undefined) return undefined;
  const urls = value
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  const scheme = kind === 'stun' ? /^stuns?:/i : /^turns?:/i;
  if (
    urls.length === 0 ||
    urls.length > 16 ||
    urls.some((url) => url.length > 2_048 || !scheme.test(url))
  ) {
    throw new Error(
      `Invalid --${kind}-url: ${value} (expected one or more comma-separated ${kind.toUpperCase()} URLs)\n\n${HELP}`
    );
  }
  return urls;
}

export function parseCliOptions(args: string[]): CliOptions {
  let values: {
    port?: string;
    host: string;
    platform?: string;
    transport?: string;
    'webrtc-codec'?: string;
    'max-dimension'?: string;
    'mjpeg-quality'?: string;
    'video-bitrate'?: string;
    'video-fps'?: string;
    'stun-url'?: string;
    'turn-url'?: string;
    'turn-username'?: string;
    'turn-credential'?: string;
    'metrics-cors-origin': string[];
    'hide-sidebar': boolean;
    help: boolean;
  };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        port: { type: 'string', short: 'p' },
        // Bind the IPv4 loopback explicitly: 'localhost' resolves to ::1 first on
        // macOS, but serve-sim's in-process state mints 127.0.0.1 URLs, so a
        // v6-only listener leaves the advertised stream/ws endpoints unreachable.
        host: { type: 'string', default: '127.0.0.1' },
        platform: { type: 'string' },
        transport: { type: 'string' },
        'webrtc-codec': { type: 'string' },
        'max-dimension': { type: 'string' },
        'mjpeg-quality': { type: 'string' },
        'video-bitrate': { type: 'string' },
        'video-fps': { type: 'string' },
        'stun-url': { type: 'string' },
        'turn-url': { type: 'string' },
        'turn-username': { type: 'string' },
        'turn-credential': { type: 'string' },
        'metrics-cors-origin': { type: 'string', multiple: true, default: [] },
        'hide-sidebar': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\n\n${HELP}`);
  }

  if (values.help) return { host: values.host, help: true };

  const port = values.port !== undefined ? Number(values.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error(`Invalid --port: ${values.port}\n\n${HELP}`);
  }

  const platform = parsePlatformFilter(values.platform);
  if (values.platform !== undefined && platform === undefined) {
    throw new Error(`Invalid --platform: ${values.platform}\n\n${HELP}`);
  }

  const transport = parseTransport(values.transport);
  if (values.transport !== undefined && transport === undefined) {
    throw new Error(`Invalid --transport: ${values.transport}\n\n${HELP}`);
  }

  const normalizedWebRtcCodec = values['webrtc-codec']?.toLowerCase();
  const webrtcCodec = WEBRTC_CODECS.includes(normalizedWebRtcCodec as WebRtcStreamCodec)
    ? (normalizedWebRtcCodec as WebRtcStreamCodec)
    : undefined;
  if (values['webrtc-codec'] !== undefined && webrtcCodec === undefined) {
    throw new Error(`Invalid --webrtc-codec: ${values['webrtc-codec']}\n\n${HELP}`);
  }

  const maxDimension = parseNumberOption(
    values['max-dimension'],
    '--max-dimension',
    0,
    4096,
    true
  );
  const mjpegQuality = parseNumberOption(values['mjpeg-quality'], '--mjpeg-quality', 0.05, 1);
  const videoBitrate = parseNumberOption(
    values['video-bitrate'],
    '--video-bitrate',
    100_000,
    50_000_000,
    true
  );
  const videoFps = parseNumberOption(values['video-fps'], '--video-fps', 1, 120, true);
  const stunUrls = parseIceUrls(values['stun-url'], 'stun');
  const turnUrls = parseIceUrls(values['turn-url'], 'turn');
  const turnUsername = values['turn-username'];
  const turnCredential = values['turn-credential'];

  const webRtcOptionProvided =
    values['webrtc-codec'] !== undefined ||
    stunUrls !== undefined ||
    turnUrls !== undefined ||
    turnUsername !== undefined ||
    turnCredential !== undefined;
  if (webRtcOptionProvided && transport !== 'webrtc') {
    throw new Error(`WebRTC options require --transport webrtc.\n\n${HELP}`);
  }
  if ((turnUsername === undefined) !== (turnCredential === undefined)) {
    throw new Error(`--turn-username and --turn-credential must be provided together.\n\n${HELP}`);
  }
  if ((turnUsername !== undefined || turnCredential !== undefined) && turnUrls === undefined) {
    throw new Error(`--turn-username and --turn-credential require --turn-url.\n\n${HELP}`);
  }

  return {
    port,
    host: values.host,
    platform,
    transport,
    webrtcCodec,
    maxDimension,
    mjpegQuality,
    videoBitrate,
    videoFps,
    stunUrls,
    turnUrls,
    turnUsername,
    turnCredential,
    metricsCorsOrigins: values['metrics-cors-origin'],
    hideSidebar: values['hide-sidebar'],
    help: false,
  };
}
