/**
 * Build the browser URLs for a serve-sim server.
 *
 * A reverse proxy can expose serve-sim at a different path from the one the
 * server uses:
 *
 * - **Public mount**: the URL where this browser reaches serve-sim. It is the
 *   hook's `baseUrl`, resolved against the page, for example
 *   `https://sim.example.test/preview/session/`.
 * - **Server base path**: the path where serve-sim thinks it is mounted.
 *   serve-sim sends it as `basePath` in `/api` and lists its routes under it,
 *   for example `/internal` with `/internal/ax?device=A`.
 *
 * Proxied connections rebase middleware and helper URLs onto the public mount.
 * Direct connections preserve advertised URLs; helpers may use another origin.
 * Log, event and metrics subscriptions inside exec-ws retain server-side paths.
 */

/** The page URL, or `undefined` outside a browser (SSR, tests without `window.location`). */
function currentPageUrl(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location?.href;
}

/**
 * Resolve the hook's `baseUrl` to the public serve-sim mount. The result
 * always ends with `/` and has no query or hash, so routes resolve under it.
 *
 * For example, `/vendor/serve-sim` on `http://localhost:8081/index` becomes
 * `http://localhost:8081/vendor/serve-sim/`.
 */
export function publicServeSimMount(baseUrl: string, pageUrl = currentPageUrl()): URL {
  const mount = new URL(baseUrl, pageUrl);
  mount.pathname = mount.pathname.replace(/\/*$/, '/');
  mount.search = '';
  mount.hash = '';
  return mount;
}

/**
 * Join a mount-relative route (with or without a leading slash) to a public
 * mount returned by `publicServeSimMount`. Preserve its query and set any
 * non-empty `query` values.
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

/** Change an `http(s)` URL to the matching `ws(s)` URL. */
export function httpToWebSocketUrl(url: string): string {
  return url.replace(/^http/, 'ws');
}
