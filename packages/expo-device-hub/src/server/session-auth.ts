import { createHash, timingSafeEqual } from 'node:crypto';

import { unauthorizedPage } from './unauthorized-page';

/**
 * The Hub's session gate: serve-sim's `--require-token` rules (`session-auth.ts`), ported to fetch
 * requests. The Hub checks every request itself and then hands the vendored serve-sim and
 * serve-emu the token as a bearer header, so one browser cookie covers the dashboard and both
 * backends.
 */

const ACCESS_COOKIE = 'expo_device_hub_access';

// Cookies ignore the port, so two Hubs on one host would overwrite each other's.
export function accessCookieName(token: string): string {
  const suffix = createHash('sha256').update(token).digest('hex').slice(0, 8);
  return `${ACCESS_COOKIE}_${suffix}`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function hasBearerToken(request: Request, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '');
  return !!match && safeEqual(match[1]!.trim(), token);
}

function hasCookieToken(request: Request, token: string): boolean {
  const name = accessCookieName(token);
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return safeEqual(decodeURIComponent(rest.join('=')), token);
    } catch {
      return false;
    }
  }
  return false;
}

function hasSubprotocolToken(request: Request, token: string, prefixes: readonly string[]): boolean {
  return (request.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .some((entry) =>
      prefixes.some(
        (prefix) => entry.startsWith(prefix) && safeEqual(entry.slice(prefix.length), token),
      ),
    );
}

// A tunnel terminates TLS, so the forwarded scheme is the only signal there.
function isHttpsRequest(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',', 1)[0]!.trim().toLowerCase() === 'https';
  return new URL(request.url).protocol === 'https:';
}

// A cookie rides along on any same-site page's requests, so cookie auth must also prove the
// origin. A bearer or query token is presented deliberately and needs no such check.
function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) return site === 'same-origin' || site === 'none';
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === (request.headers.get('host') ?? new URL(request.url).host);
  } catch {
    return false;
  }
}

function isNavigation(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const mode = request.headers.get('sec-fetch-mode');
  return mode === null || mode === 'navigate';
}

function isDocumentNavigation(request: Request): boolean {
  const dest = request.headers.get('sec-fetch-dest');
  if (dest !== null) return dest === 'document';
  return (request.headers.get('accept') ?? '').includes('text/html');
}

function isEmbeddedNavigation(request: Request): boolean {
  return isNavigation(request) && request.headers.get('sec-fetch-dest') === 'iframe';
}

// A Lax cookie rides a cross-site request only as a top-level navigation, and that page cannot
// read the response. The hop after the token redirect still reports cross-site.
function isTopLevelNavigation(request: Request): boolean {
  return isNavigation(request) && isDocumentNavigation(request);
}

function prefersHtmlResponse(request: Request): boolean {
  return isDocumentNavigation(request) || isEmbeddedNavigation(request);
}

// A cross-site frame never receives a Lax cookie. Partitioned keys the cookie to the embedding
// site, so another site's frame gets none of it. Both need Secure, so plain http stays on Lax.
function accessCookie(token: string, path: string, secure: boolean, embedded: boolean): string {
  const partitioned = secure && embedded;
  return [
    `${accessCookieName(token)}=${encodeURIComponent(token)}`,
    'HttpOnly',
    partitioned ? 'SameSite=None' : 'SameSite=Lax',
    `Path=${path}`,
    ...(secure ? ['Secure'] : []),
    ...(partitioned ? ['Partitioned'] : []),
  ].join('; ');
}

export type SessionGateOptions = {
  /** Where the Hub is mounted ('' for the origin root). Scopes the cookie and the redirect. */
  mountPath: string;
  /** Added to an HTML response, such as the frame policy. */
  htmlHeaders?: Record<string, string>;
  /** False ignores `?token=`, as serve-sim does on its capture routes. */
  allowQueryToken?: boolean;
};

/** Null lets the request through; otherwise the response that answers it. */
export function authorizeRequest(
  request: Request,
  token: string,
  { mountPath, htmlHeaders, allowQueryToken = true }: SessionGateOptions,
): Response | null {
  const url = new URL(request.url);
  const fromQuery = allowQueryToken ? url.searchParams.get('token') : null;
  if (fromQuery !== null && safeEqual(fromQuery, token)) {
    // A page load trades the token for a cookie, so it leaves the URL and the page's own requests
    // carry it. A caller that can set neither header nor cookie, such as EventSource, is served.
    if (!prefersHtmlResponse(request)) return null;
    url.searchParams.delete('token');
    return new Response(null, {
      status: 302,
      headers: {
        // A leading "//" would be read as an absolute URL on another origin.
        Location: `${mountPath}${url.pathname}`.replace(/^\/+/, '/') + url.search,
        'Set-Cookie': accessCookie(token, mountPath || '/', isHttpsRequest(request), isEmbeddedNavigation(request)),
        'Cache-Control': 'no-store, private',
      },
    });
  }

  if (hasBearerToken(request, token)) return null;
  if (
    hasCookieToken(request, token) &&
    (isSameOriginRequest(request) || isTopLevelNavigation(request) || isEmbeddedNavigation(request))
  ) {
    return null;
  }

  if (prefersHtmlResponse(request)) {
    return new Response(unauthorizedPage({ rejectedToken: !!fromQuery }), {
      status: 401,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, private',
        ...htmlHeaders,
      },
    });
  }
  return new Response(
    JSON.stringify({
      ok: false,
      error:
        'Unauthorized. This Expo Device Hub was started with --require-token. Open the link it ' +
        'printed at startup, which carries the token, or send it as `Authorization: Bearer <token>`.',
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, private',
        'WWW-Authenticate': 'Bearer',
      },
    },
  );
}

/**
 * A WebSocket takes a bearer header, a token subprotocol, or a same-origin cookie. No `?token=`.
 * Browsers name the token as a subprotocol under the prefix of the backend they reach through
 * the Hub, so the caller passes each backend's prefix.
 */
export function authorizeUpgrade(
  request: Request,
  token: string,
  subprotocolPrefixes: readonly string[],
): boolean {
  if (hasBearerToken(request, token) || hasSubprotocolToken(request, token, subprotocolPrefixes)) {
    return true;
  }
  return hasCookieToken(request, token) && isSameOriginRequest(request);
}

/** A copy of an authorized request that carries the token as a bearer, for the backends' gates. */
export function withBearerToken(request: Request, token: string): Request {
  const authorized = new Request(request.url, request);
  authorized.headers.set('authorization', `Bearer ${token}`);
  return authorized;
}

// serve-sim's rule: a subdomain wildcard needs two labels after the star, so `*.com` is dropped.
const FRAMEABLE_ORIGIN =
  /^https?:\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+|\*\.[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?$/i;

/**
 * Who may frame the gated Hub. Browsers that ignore the Partitioned cookie attribute would
 * otherwise let any site embed it and drive it. Shapes that would widen the policy are dropped.
 */
export function frameAncestorsPolicy(allowedOrigins: readonly string[]): string {
  const origins = allowedOrigins.flatMap((allowed) => {
    try {
      const { origin } = new URL(allowed);
      return FRAMEABLE_ORIGIN.test(origin) ? [origin] : [];
    } catch {
      return [];
    }
  });
  return ['frame-ancestors', "'self'", ...origins].join(' ');
}
