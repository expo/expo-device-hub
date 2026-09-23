/**
 * Presenting a serve-sim session token (`serve-sim --require-token`).
 *
 * serve-sim gates every route as a whole when the flag is set. The browser has
 * three ways to present the token, and which one a request uses depends on
 * what the request is:
 *
 *   - `Authorization: Bearer <token>` on anything that can set a header (fetch).
 *   - `?token=<token>` on a request that cannot: an `<img>` stream, an
 *     `EventSource`, a `sendBeacon`. serve-sim answers a non-navigation request
 *     carrying the query token directly.
 *   - The `serve-sim.token.<token>` WebSocket subprotocol (expo/serve-sim#173).
 *     A browser cannot set a header on a WebSocket and does not send the cookie
 *     cross-origin, so the token rides in `Sec-WebSocket-Protocol`. The Hub
 *     server also accepts it and forwards it to the middleware as a bearer.
 *
 * Every helper here is a no-op for a missing token so the ungated path stays
 * byte-for-byte what it was.
 */

export const TOKEN_SUBPROTOCOL_PREFIX = 'serve-sim.token.';

// RFC 7230 token charset: the only characters a subprotocol entry may carry.
// base64url tokens always pass; a padded base64 token (`=`) does not.
const SUBPROTOCOL_TOKEN = /^[!#$%&'*+\-.0-9A-Za-z^_`|~]+$/;

export type AccessToken = string | null | undefined;

/** Treat an empty string like an absent token. */
export function normalizeAccessToken(token: AccessToken): string | null {
  return token ? token : null;
}

/** `Authorization` header for a fetch, or nothing when there is no token. */
export function accessTokenHeaders(token: AccessToken): Record<string, string> {
  const normalized = normalizeAccessToken(token);
  return normalized ? { Authorization: `Bearer ${normalized}` } : {};
}

/** Merge the token header into a request's headers, keeping the caller's. */
export function withAccessTokenHeaders(
  init: RequestInit | undefined,
  token: AccessToken,
): RequestInit | undefined {
  const auth = accessTokenHeaders(token);
  if (Object.keys(auth).length === 0) return init;
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(auth)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return { ...init, headers };
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A `fetch` that presents the token on every request it makes. */
export function accessTokenFetch(token: AccessToken, fetchImpl: FetchLike = fetch): FetchLike {
  if (!normalizeAccessToken(token)) return fetchImpl;
  return (input, init) => fetchImpl(input, withAccessTokenHeaders(init, token));
}

/**
 * Append `token=` to a URL for a request that cannot carry a header. Leaves a
 * URL that already names a token alone.
 */
export function withAccessTokenQuery(url: string, token: AccessToken): string {
  const normalized = normalizeAccessToken(token);
  if (!normalized) return url;
  const [withoutHash, hash = ''] = splitHash(url);
  const separator = withoutHash.includes('?') ? '&' : '?';
  if (/[?&]token=/.test(withoutHash)) return url;
  return `${withoutHash}${separator}token=${encodeURIComponent(normalized)}${hash}`;
}

function splitHash(url: string): [string, string] {
  const index = url.indexOf('#');
  return index === -1 ? [url, ''] : [url.slice(0, index), url.slice(index)];
}

/**
 * Subprotocol list for a WebSocket handshake, or `undefined` when there is no
 * token or the token has a character a subprotocol cannot carry.
 */
export function accessTokenSubprotocols(token: AccessToken): string[] | undefined {
  const normalized = normalizeAccessToken(token);
  if (!normalized || !SUBPROTOCOL_TOKEN.test(normalized)) return undefined;
  return [`${TOKEN_SUBPROTOCOL_PREFIX}${normalized}`];
}

/**
 * Open a WebSocket that names the token as a subprotocol when it has one.
 * Throws whatever the `WebSocket` constructor throws, like `new WebSocket(url)`.
 */
export function openAccessTokenWebSocket(url: string, token: AccessToken): WebSocket {
  const protocols = accessTokenSubprotocols(token);
  return protocols ? new WebSocket(url, protocols) : new WebSocket(url);
}
