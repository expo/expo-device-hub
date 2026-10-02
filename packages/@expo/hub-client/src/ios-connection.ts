import {
  httpToWebSocketUrl,
  publicUrlForAdvertisedPath,
  publicUrlForRoute,
} from './serve-sim-urls';
import { type DeviceStreamEncoderSettings } from './types';
import { type WebRtcIceServer } from './useWebRtcStream';
import { type WebRtcCodec } from './webrtc-fallback';

/** Shape of the serve-sim middleware `/api` (and grid) responses we read. */
export interface PreviewApi {
  url?: string;
  streamUrl?: string;
  wsUrl?: string;
  device?: string;
  basePath?: string;
  execToken?: string;
  logsEndpoint?: string;
  appStateEndpoint?: string;
  eventLogEventsEndpoint?: string;
  metricsEndpoint?: string;
  axEndpoint?: string;
  streamSettingsEndpoint?: string;
  gridApiEndpoint?: string;
  proxyHelpers?: boolean;
  streamSettings?:
    | ({
        transport: 'http';
        codec?: 'auto' | 'h264' | 'mjpeg';
      } & Partial<DeviceStreamEncoderSettings>)
    | ({
        transport: 'webrtc';
        codec: WebRtcCodec;
        iceServers?: WebRtcIceServer[];
      } & Partial<DeviceStreamEncoderSettings>);
}

/** An `/api` response with a helper attached to a device. */
export type AttachedPreviewApi = PreviewApi & { url: string; device: string };

/** A helper is attached only when `/api` supplies both its URL and device ID. */
export function isAttachedPreviewApi(api: PreviewApi | null): api is AttachedPreviewApi {
  return !!api?.url && !!api.device;
}

/** Resolved connection: where to stream video/input, and how to reach logs/devices. */
export interface ResolvedIosConnection {
  /** Base serve-sim helper URL used by `/stream.avcc`. */
  url: string;
  streamUrl: string;
  wsUrl: string;
  device: string;
  /** Middleware exec-ws URL used for logs, events, metrics, and UI requests. */
  execWsUrl: string;
  execToken: string | null;
  /** Server-side SSE path subscribed through exec-ws, e.g. `/internal/logs?device=A`. */
  logsPath: string | null;
  /** Absolute URL of the foreground-app SSE stream. */
  appStateUrl: string | null;
  /** Server-side SSE path for normalized serve-sim events, subscribed through exec-ws. */
  eventsPath: string | null;
  /** Server-side SSE path for foreground app activity, subscribed through exec-ws. */
  metricsPath: string | null;
  axUrl: string | null;
  /** Runtime encoder settings endpoint on the selected helper. */
  streamSettingsUrl: string | null;
  /** Initial server-provided stream settings, if present. */
  initialStreamSettings: unknown;
  gridApiUrl: string;
  webRtcCodec: WebRtcCodec;
  webRtcIceServers?: WebRtcIceServer[];
}

/** Convert serve-sim's advertised `/helper/<udid>/ws` to `/helper/ws?device=<udid>`. */
export function toQueryStyleHelperWsUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  const match = url.pathname.match(/^(.*\/helper)\/([^/]+)\/ws$/);
  if (!match) throw new Error(`Invalid helper ws url, no deviceId matched: ${wsUrl}`);
  url.pathname = `${match[1]}/ws`;
  if (!url.searchParams.has('device')) {
    url.searchParams.set('device', decodeURIComponent(match[2]));
  }
  return url.toString();
}

type HelperUrls = Pick<ResolvedIosConnection, 'url' | 'streamUrl' | 'wsUrl' | 'streamSettingsUrl'>;

/**
 * Proxy helpers use the public mount because advertised URLs may contain an
 * internal host or port. Direct HTTP URLs keep their advertised origins and
 * paths; direct WebSocket URLs switch to serve-sim's device query route.
 */
function resolveHelperUrls(api: AttachedPreviewApi, publicMount: URL): HelperUrls {
  if (api.proxyHelpers) {
    const helperUrl = publicUrlForRoute(publicMount, `helper/${encodeURIComponent(api.device)}`);
    return {
      url: helperUrl,
      streamUrl: `${helperUrl}/stream.mjpeg`,
      wsUrl: httpToWebSocketUrl(
        publicUrlForRoute(publicMount, 'helper/ws', { device: api.device }),
      ),
      streamSettingsUrl: `${helperUrl}/stream-settings`,
    };
  }

  return {
    url: api.url,
    streamUrl: api.streamUrl ?? `${api.url}/stream.mjpeg`,
    wsUrl: toQueryStyleHelperWsUrl(api.wsUrl ?? `${httpToWebSocketUrl(api.url)}/ws`),
    streamSettingsUrl: api.streamSettingsEndpoint
      ? new URL(api.streamSettingsEndpoint, publicMount).toString()
      : null,
  };
}

/**
 * Turn an attached `/api` response into browser URLs. `publicMount` is the
 * public serve-sim mount (see `publicServeSimMount`).
 *
 * The log, event and metrics paths stay as advertised. They are subscription
 * paths inside exec-ws, and the server checks them against its own mount.
 */
export function resolveIosConnection(
  api: AttachedPreviewApi,
  publicMount: URL,
): ResolvedIosConnection {
  const serverBasePath = (api.basePath ?? '').replace(/\/+$/, '');
  // Proxied middleware paths move from the server base path to the public mount.
  // Direct middleware paths and absolute URLs resolve as advertised.
  const middlewareUrl = (serverPath: string): string =>
    api.proxyHelpers
      ? publicUrlForAdvertisedPath(publicMount, serverPath, serverBasePath)
      : new URL(serverPath, publicMount).toString();
  const optionalMiddlewareUrl = (serverPath?: string): string | null =>
    serverPath ? middlewareUrl(serverPath) : null;
  const webRtcSettings = api.streamSettings?.transport === 'webrtc' ? api.streamSettings : null;

  return {
    ...resolveHelperUrls(api, publicMount),
    device: api.device,
    execWsUrl: httpToWebSocketUrl(middlewareUrl(`${serverBasePath}/exec-ws`)),
    execToken: api.execToken ?? null,
    logsPath: api.logsEndpoint ?? null,
    appStateUrl: optionalMiddlewareUrl(api.appStateEndpoint),
    eventsPath: api.eventLogEventsEndpoint ?? null,
    metricsPath: api.metricsEndpoint ?? null,
    axUrl: optionalMiddlewareUrl(api.axEndpoint),
    initialStreamSettings: api.streamSettings,
    gridApiUrl: middlewareUrl(api.gridApiEndpoint || `${serverBasePath}/grid/api`),
    webRtcCodec: webRtcSettings ? webRtcSettings.codec : 'h264',
    ...(webRtcSettings?.iceServers ? { webRtcIceServers: webRtcSettings.iceServers } : {}),
  };
}
