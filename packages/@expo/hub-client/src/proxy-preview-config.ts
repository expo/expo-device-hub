export interface ProxyPreviewConfig {
  device?: string;
  basePath?: string;
  proxyHelpers?: boolean;
  url?: string;
  streamUrl?: string;
  wsUrl?: string;
  streamSettingsEndpoint?: string;
}

/**
 * Resolve proxied helper URLs against the public middleware mount. The config
 * can advertise internal paths or an unusable port, while the caller's base URL
 * is the server and mount the browser can actually reach.
 */
export function proxyPreviewConfigForBrowser<T extends ProxyPreviewConfig>(
  config: T,
  middlewareUrl: URL,
): T {
  if (!config.device || !config.proxyHelpers) return config;

  const mountPath = middlewareUrl.pathname.replace(/\/+$/, '');
  const devicePath = `${mountPath}/helper/${encodeURIComponent(config.device)}`;
  const httpOrigin = middlewareUrl.origin;
  const wsProtocol = middlewareUrl.protocol === 'https:' ? 'wss:' : 'ws:';

  return {
    ...config,
    url: `${httpOrigin}${devicePath}`,
    streamUrl: `${httpOrigin}${devicePath}/stream.mjpeg`,
    wsUrl: `${wsProtocol}//${middlewareUrl.host}${devicePath}/ws`,
    streamSettingsEndpoint: `${httpOrigin}${devicePath}/stream-settings`,
  };
}
