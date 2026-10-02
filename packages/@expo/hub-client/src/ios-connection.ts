import {
  httpToWebSocketUrl,
  publicUrlForAdvertisedPath,
  publicUrlForRoute,
} from './serve-sim-urls.js';
import { type DeviceStreamEncoderSettings } from './types.js';
import { type WebRtcIceServer } from './useWebRtcStream.js';
import { type WebRtcCodec } from './webrtc-fallback.js';

/** Shape of the serve-sim middleware `/api` (and grid) responses we read. */
export interface PreviewApi {
  url?: string;
  streamUrl?: string;
  wsUrl?: string;
  inputAdmission?: unknown;
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
    | ({ transport: 'http'; codec?: 'auto' | 'h264' | 'mjpeg' } &
        Partial<DeviceStreamEncoderSettings>)
    | ({ transport: 'webrtc'; codec: WebRtcCodec; iceServers?: WebRtcIceServer[] } &
        Partial<DeviceStreamEncoderSettings>);
}

/** An `/api` response with a helper attached to a device. */
export type AttachedPreviewApi = PreviewApi & { url: string; device: string };

/**
 * True when `/api` reports a helper attached to a device.
 *
 * @example
 * isAttachedPreviewApi({ url: 'http://localhost:3100/helper/A', device: 'A' }) // → true
 * isAttachedPreviewApi({ device: 'A' })                                       // → false (helper is starting)
 * isAttachedPreviewApi(null)                                                  // → false (no device)
 */
export function isAttachedPreviewApi(api: PreviewApi | null): api is AttachedPreviewApi {
  return !!api?.url && !!api.device;
}

/** Resolved connection: where to stream video/input, and how to reach logs/devices. */
export interface ResolvedIosConnection {
  /** Base serve-sim helper URL used by `/stream.avcc`. */
  url: string;
  streamUrl: string;
  wsUrl: string;
  inputAdmission: boolean;
  device: string | null;
  /** Middleware exec-ws URL used for logs, events, metrics, and UI requests. */
  execWsUrl: string | null;
  execToken: string | null;
  /** Relative SSE path to subscribe for logs, e.g. `/logs?device=<udid>`. */
  logsPath: string | null;
  /** Absolute URL of the foreground-app SSE stream. */
  appStateUrl: string | null;
  /** Relative SSE path for normalized serve-sim events. */
  eventsPath: string | null;
  /** Relative SSE path for foreground app activity. */
  metricsPath: string | null;
  axUrl: string | null;
  /** Runtime encoder settings endpoint on the selected helper. */
  streamSettingsUrl: string | null;
  /** Initial server-provided stream settings, if present. */
  initialStreamSettings: unknown;
  gridApiUrl: string | null;
  webRtcCodec: WebRtcCodec;
  webRtcIceServers?: WebRtcIceServer[];
}

/**
 * `…/helper/<udid>/ws` -> `…/helper/ws?device=<udid>`
 * serve-sim
 */
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

/** Browser URLs for the middleware routes, in one serve-sim mode. */
interface MiddlewareUrlResolver {
  /** Browser URL for a route that `/api` advertised, such as `axEndpoint`. */
  forAdvertisedPath(advertisedPath: string): string;
  /** Browser URL for a fixed middleware route, such as `exec-ws`. */
  forRoute(route: string): string;
}

/**
 * Proxy mode (`proxyHelpers: true`): the browser reaches every route through
 * the public mount, and the advertised routes use the server base path.
 *
 * @example
 * const urls = proxiedMiddlewareUrls(new URL('https://sim.example.test/session/'), '/internal');
 * urls.forAdvertisedPath('/internal/ax?device=A') // → 'https://sim.example.test/session/ax?device=A'
 * urls.forRoute('exec-ws')                        // → 'https://sim.example.test/session/exec-ws'
 */
function proxiedMiddlewareUrls(mount: URL, serverBasePath: string): MiddlewareUrlResolver {
  return {
    forAdvertisedPath: (advertisedPath) =>
      publicUrlForAdvertisedPath(mount, advertisedPath, serverBasePath),
    forRoute: (route) => publicUrlForRoute(mount, route),
  };
}

/**
 * Direct mode: the server and the browser share one mount, so advertised paths
 * resolve against the mount's origin as they are. A remote mount with another
 * path is not supported in this mode.
 *
 * @example
 * const urls = directMiddlewareUrls(new URL('http://localhost:8081/vendor/serve-sim/'), '/vendor/serve-sim');
 * urls.forAdvertisedPath('/vendor/serve-sim/ax?device=A') // → 'http://localhost:8081/vendor/serve-sim/ax?device=A'
 * urls.forRoute('exec-ws')                                // → 'http://localhost:8081/vendor/serve-sim/exec-ws'
 */
function directMiddlewareUrls(mount: URL, serverBasePath: string): MiddlewareUrlResolver {
  return {
    forAdvertisedPath: (advertisedPath) => new URL(advertisedPath, mount).toString(),
    forRoute: (route) => new URL(`${serverBasePath}/${route}`, mount).toString(),
  };
}

type HelperUrls = Pick<ResolvedIosConnection, 'url' | 'streamUrl' | 'wsUrl' | 'streamSettingsUrl'>;

/**
 * Proxy mode: the helper is reached through `<mount>/helper/<udid>`. The
 * advertised helper URLs are ignored, because they can carry an internal path
 * or an unusable port such as `:0`.
 *
 * @example
 * proxiedHelperUrls(new URL('https://sim.example.test/session/'), 'DEVICE-A')
 * // → {
 * //   url: 'https://sim.example.test/session/helper/DEVICE-A',
 * //   streamUrl: 'https://sim.example.test/session/helper/DEVICE-A/stream.mjpeg',
 * //   wsUrl: 'wss://sim.example.test/session/helper/ws?device=DEVICE-A',
 * //   streamSettingsUrl: 'https://sim.example.test/session/helper/DEVICE-A/stream-settings',
 * // }
 */
function proxiedHelperUrls(mount: URL, device: string): HelperUrls {
  const helperUrl = publicUrlForRoute(mount, `helper/${encodeURIComponent(device)}`);
  return {
    url: helperUrl,
    streamUrl: `${helperUrl}/stream.mjpeg`,
    wsUrl: httpToWebSocketUrl(publicUrlForRoute(mount, 'helper/ws', { device })),
    streamSettingsUrl: `${helperUrl}/stream-settings`,
  };
}

/**
 * Direct mode: use the helper URLs from `/api` as they are.
 *
 * @example
 * directHelperUrls({ url: 'http://192.168.1.5:3100/helper/DEVICE-A', device: 'DEVICE-A' }, urls)
 * // → {
 * //   url: 'http://192.168.1.5:3100/helper/DEVICE-A',
 * //   streamUrl: 'http://192.168.1.5:3100/helper/DEVICE-A/stream.mjpeg',
 * //   wsUrl: 'ws://192.168.1.5:3100/helper/ws?device=DEVICE-A',
 * //   streamSettingsUrl: null,
 * // }
 */
function directHelperUrls(api: AttachedPreviewApi, middlewareUrls: MiddlewareUrlResolver): HelperUrls {
  return {
    url: api.url,
    streamUrl: api.streamUrl ?? `${api.url}/stream.mjpeg`,
    wsUrl: toQueryStyleHelperWsUrl(api.wsUrl ?? `${httpToWebSocketUrl(api.url)}/ws`),
    streamSettingsUrl: api.streamSettingsEndpoint
      ? middlewareUrls.forAdvertisedPath(api.streamSettingsEndpoint)
      : null,
  };
}

/**
 * Turn an `/api` response into the URLs that the browser uses. `mount` is the
 * public serve-sim mount (see `publicServeSimMount`).
 *
 * The log, event and metrics paths stay as advertised. They are subscription
 * paths inside exec-ws, and the server checks them against its own mount.
 *
 * @example
 * resolveIosConnection(
 *   {
 *     device: 'DEVICE-A',
 *     url: 'https://sim.example.test:0/internal/helper/DEVICE-A',
 *     basePath: '/internal',
 *     proxyHelpers: true,
 *     axEndpoint: '/internal/ax?device=DEVICE-A',
 *     logsEndpoint: '/internal/logs?device=DEVICE-A',
 *   },
 *   new URL('https://sim.example.test/session/'),
 * )
 * // → {
 * //   url: 'https://sim.example.test/session/helper/DEVICE-A',
 * //   execWsUrl: 'wss://sim.example.test/session/exec-ws',
 * //   axUrl: 'https://sim.example.test/session/ax?device=DEVICE-A',
 * //   gridApiUrl: 'https://sim.example.test/session/grid/api',
 * //   logsPath: '/internal/logs?device=DEVICE-A',
 * //   …
 * // }
 */
export function resolveIosConnection(api: AttachedPreviewApi, mount: URL): ResolvedIosConnection {
  const serverBasePath = (api.basePath ?? '').replace(/\/+$/, '');
  const middlewareUrls = api.proxyHelpers
    ? proxiedMiddlewareUrls(mount, serverBasePath)
    : directMiddlewareUrls(mount, serverBasePath);
  const helperUrls = api.proxyHelpers
    ? proxiedHelperUrls(mount, api.device)
    : directHelperUrls(api, middlewareUrls);
  const advertisedUrl = (advertisedPath?: string): string | null =>
    advertisedPath ? middlewareUrls.forAdvertisedPath(advertisedPath) : null;
  const webRtcSettings = api.streamSettings?.transport === 'webrtc' ? api.streamSettings : null;

  return {
    ...helperUrls,
    inputAdmission: api.inputAdmission !== undefined && api.inputAdmission !== false,
    device: api.device,
    execWsUrl: httpToWebSocketUrl(middlewareUrls.forRoute('exec-ws')),
    execToken: api.execToken ?? null,
    logsPath: api.logsEndpoint ?? null,
    appStateUrl: advertisedUrl(api.appStateEndpoint),
    eventsPath: api.eventLogEventsEndpoint ?? null,
    metricsPath: api.metricsEndpoint ?? null,
    axUrl: advertisedUrl(api.axEndpoint),
    initialStreamSettings: api.streamSettings,
    gridApiUrl: advertisedUrl(api.gridApiEndpoint) ?? middlewareUrls.forRoute('grid/api'),
    webRtcCodec: webRtcSettings ? webRtcSettings.codec : 'h264',
    ...(webRtcSettings?.iceServers ? { webRtcIceServers: webRtcSettings.iceServers } : {}),
  };
}
