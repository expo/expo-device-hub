export interface ProxyPreviewConfig {
  device?: string;
  basePath?: string;
  proxyHelpers?: boolean;
  url?: string;
  streamUrl?: string;
  wsUrl?: string;
  streamSettingsEndpoint?: string;
}

type LocationLike = Pick<Location, 'host' | 'protocol'>;

/**
 * Where the proxied helper URLs must point: the origin the middleware was
 * reached on. serve-sim's own UI uses `window.location`, because serve-sim
 * serves that page itself. A hub-client consumer may run on another origin
 * (a hosted dashboard with an `accessToken`), and its helper requests still
 * have to go to the Hub, not to the page's own host. A relative `baseUrl`
 * means same-origin, so the page's location is right in that case.
 */
export function locationForBaseUrl(baseUrl: string, fallback: LocationLike): LocationLike {
  try {
    const { host, protocol } = new URL(baseUrl);
    if (host && (protocol === 'http:' || protocol === 'https:')) return { host, protocol };
  } catch {}
  return fallback;
}

/**
 * Re-anchor the helper URLs in a middleware `/api` config to the browser's own
 * origin, mirroring serve-sim's `utils/preview-config.ts`. Only applies when the
 * server opted into same-origin proxying (`proxyHelpers`); otherwise the config
 * already carries the helper's direct URLs and is used as-is.
 */
export function proxyPreviewConfigForBrowser<T extends ProxyPreviewConfig>(
  config: T,
  location: LocationLike,
): T {
  if (!config.device || !config.proxyHelpers) return config;

  const basePath = config.basePath === '/' ? '' : (config.basePath ?? '').replace(/\/+$/, '');
  const devicePath = `${basePath}/helper/${encodeURIComponent(config.device)}`;
  const httpOrigin = `${location.protocol}//${location.host}`;
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

  return {
    ...config,
    url: `${httpOrigin}${devicePath}`,
    streamUrl: `${httpOrigin}${devicePath}/stream.mjpeg`,
    wsUrl: `${wsProtocol}//${location.host}${devicePath}/ws`,
    streamSettingsEndpoint: `${httpOrigin}${devicePath}/stream-settings`,
  };
}
