export interface ProxyPreviewConfig {
  device?: string;
  basePath?: string;
  proxyHelpers?: boolean;
  url?: string;
  streamUrl?: string;
  wsUrl?: string;
  streamSettingsEndpoint?: string;
}

/** Strip the advertised mount and resolve the route under the public `baseUrl` mount. */
export function middlewareEndpointForBrowser(
  advertisedPath: string,
  middlewareUrl: URL,
  basePath: string = '',
): string {
  const mountPath = middlewareUrl.pathname.replace(/\/+$/, '');
  const internalPath = basePath.replace(/\/+$/, '');
  const publicEndpoint = new URL(middlewareUrl);
  publicEndpoint.pathname = `${mountPath}/`;
  publicEndpoint.search = '';
  publicEndpoint.hash = '';

  // Resolve against the server's own mount so relative and absolute paths both carry basePath.
  const endpoint = new URL(advertisedPath, new URL(`${internalPath}/`, publicEndpoint));
  const hasBase =
    internalPath !== '' &&
    (endpoint.pathname === internalPath || endpoint.pathname.startsWith(`${internalPath}/`));
  const route = endpoint.pathname.slice(hasBase ? internalPath.length : 0).replace(/^\/+/, '');
  publicEndpoint.pathname = `${mountPath}/${route}`;
  publicEndpoint.search = endpoint.search;
  publicEndpoint.hash = endpoint.hash;
  return publicEndpoint.toString();
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
