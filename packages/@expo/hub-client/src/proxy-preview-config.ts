export interface ProxyPreviewConfig {
  device?: string;
  basePath?: string;
  proxyHelpers?: boolean;
  url?: string;
  streamUrl?: string;
  wsUrl?: string;
  streamSettingsEndpoint?: string;
}

/** Map a middleware route advertised under `basePath` onto its public mount. */
export function middlewareEndpointForBrowser(
  advertisedPath: string,
  middlewareUrl: URL,
  basePath: string = '',
): string {
  const mountPath = middlewareUrl.pathname.replace(/\/+$/, '');
  const internalPath = basePath === '/' ? '' : basePath.replace(/\/+$/, '');
  const mountUrl = new URL(middlewareUrl);
  mountUrl.pathname = `${mountPath}/`;
  mountUrl.search = '';
  mountUrl.hash = '';

  const endpoint = new URL(advertisedPath, mountUrl);
  // Relative endpoints already resolve under the public mount.
  if (!advertisedPath.startsWith('/') && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(advertisedPath)) {
    return endpoint.toString();
  }
  const advertisedMount = internalPath &&
    (endpoint.pathname === internalPath || endpoint.pathname.startsWith(`${internalPath}/`))
    ? internalPath
    : mountPath && (endpoint.pathname === mountPath || endpoint.pathname.startsWith(`${mountPath}/`))
      ? mountPath
      : '';

  const publicEndpoint = new URL(middlewareUrl);
  publicEndpoint.pathname = `${mountPath}${endpoint.pathname.slice(advertisedMount.length)}` || '/';
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
