/**
 * Build the browser URLs for a serve-sim server.
 *
 * Two path spaces exist. They are different when serve-sim runs behind a
 * reverse proxy or on another origin:
 *
 * - **Public mount**: the URL where this browser reaches serve-sim. It is the
 *   hook's `baseUrl`, resolved against the page, for example
 *   `https://sim.example.test/preview/session/`.
 * - **Server base path**: the path where serve-sim thinks it is mounted.
 *   serve-sim sends it as `basePath` in `/api` and lists its routes under it,
 *   for example `/internal` with `/internal/ax?device=A`.
 *
 * Browser requests always go to the public mount. The server base path is
 * only removed from the routes that the server advertises.
 */

/** The page URL, or `undefined` outside a browser (SSR, tests without `window.location`). */
function currentPageUrl(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location?.href;
}

/**
 * Resolve the hook's `baseUrl` to the public serve-sim mount. The result
 * always ends with `/` and has no query or hash, so routes resolve under it.
 *
 * @example
 * publicServeSimMount('/vendor/serve-sim', 'http://localhost:8081/index')
 * // → URL('http://localhost:8081/vendor/serve-sim/')
 * publicServeSimMount('https://sim.example.test/preview/session?x=1')
 * // → URL('https://sim.example.test/preview/session/')
 */
export function publicServeSimMount(baseUrl: string, pageUrl = currentPageUrl()): URL {
  const mount = new URL(baseUrl, pageUrl);
  mount.pathname = mount.pathname.replace(/\/*$/, '/');
  mount.search = '';
  mount.hash = '';
  return mount;
}

/**
 * Build the URL of a route under the public mount. `route` is relative to the
 * mount and can carry its own query. Empty `query` values are skipped.
 *
 * @example
 * const mount = new URL('https://sim.example.test/preview/session/');
 * publicUrlForRoute(mount, 'grid/api')
 * // → 'https://sim.example.test/preview/session/grid/api'
 * publicUrlForRoute(mount, '/api', { device: 'DEVICE A' })
 * // → 'https://sim.example.test/preview/session/api?device=DEVICE+A'
 * publicUrlForRoute(mount, 'ax?device=A')
 * // → 'https://sim.example.test/preview/session/ax?device=A'
 */
export function publicUrlForRoute(
  mount: URL,
  route: string,
  query: Record<string, string | null | undefined> = {},
): string {
  // `./` keeps a route such as `a:b` from being read as a URL scheme.
  const url = new URL(`./${route.replace(/^\/+/, '')}`, mount);
  for (const [name, value] of Object.entries(query)) {
    if (value) url.searchParams.set(name, value);
  }
  return url.toString();
}

/**
 * Remove the server base path from a route that the server advertised. The
 * result is relative to the mount and keeps the query. The host of a full URL
 * is ignored. A path without the base path keeps its full path.
 *
 * @example
 * routeWithoutServerBasePath('/internal/ax?device=A', '/internal')               // → 'ax?device=A'
 * routeWithoutServerBasePath('http://127.0.0.1:3200/internal/logs', '/internal') // → 'logs'
 * routeWithoutServerBasePath('/grid/api', '')                                    // → 'grid/api'
 * routeWithoutServerBasePath('/ax', '/internal')                                 // → 'ax'
 */
export function routeWithoutServerBasePath(advertisedPath: string, serverBasePath: string): string {
  const { pathname, search } = new URL(advertisedPath, 'http://server.invalid/');
  const base = serverBasePath.replace(/\/+$/, '');
  const hasBase = base !== '' && (pathname === base || pathname.startsWith(`${base}/`));
  const route = hasBase ? pathname.slice(base.length) : pathname;
  return `${route.replace(/^\/+/, '')}${search}`;
}

/**
 * Move a route that the server advertised from the server base path to the
 * public mount.
 *
 * @example
 * const mount = new URL('https://sim.example.test/preview/session/');
 * publicUrlForAdvertisedPath(mount, '/internal/ax?device=A', '/internal')
 * // → 'https://sim.example.test/preview/session/ax?device=A'
 *
 * // A root-mounted server that a proxy exposes under /grid keeps its own /grid route.
 * publicUrlForAdvertisedPath(new URL('https://sim.example.test/grid/'), '/grid/api', '')
 * // → 'https://sim.example.test/grid/grid/api'
 */
export function publicUrlForAdvertisedPath(
  mount: URL,
  advertisedPath: string,
  serverBasePath: string,
): string {
  return publicUrlForRoute(mount, routeWithoutServerBasePath(advertisedPath, serverBasePath));
}

/**
 * Change an `http(s)` URL to the matching `ws(s)` URL.
 *
 * @example
 * httpToWebSocketUrl('https://sim.example.test/exec-ws') // → 'wss://sim.example.test/exec-ws'
 * httpToWebSocketUrl('http://localhost:3200/exec-ws')    // → 'ws://localhost:3200/exec-ws'
 */
export function httpToWebSocketUrl(url: string): string {
  return url.replace(/^http/, 'ws');
}
