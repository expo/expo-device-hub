export interface ProxyPreviewConfig {
  device?: string;
  basePath?: string;
  proxyHelpers?: boolean;
  url?: string;
  streamUrl?: string;
  wsUrl?: string;
}

type LocationLike = Pick<Location, 'host' | 'protocol'>;

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
  };
}
