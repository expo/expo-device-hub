/**
 * The Hub's `--require-token` session token.
 *
 * The token is serve-sim's: the Hub mints it, hands it to the mounted serve-sim
 * middleware as both `execToken` and the preview gate (`requirePreviewToken`),
 * and saves authenticated dashboard links in a private file. serve-sim then refuses every
 * simulator route (stream, input, exec, grid) that does not present it.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Same shape serve-sim mints: 32 random bytes, base64url, so it is safe in a URL and a subprotocol. */
export function mintAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Dashboard link that carries the token, which the dashboard reads once and drops from the URL. */
export function dashboardUrlWithToken(origin: string, token: string | undefined): string {
  return token ? `${origin}/#token=${encodeURIComponent(token)}` : origin;
}

/** Gate Hub lifecycle actions before parsing their bodies or touching a device. */
export function authorizeDeviceManagement(request: Request, token: string | undefined): Response | null {
  if (token === undefined) return null;
  const supplied = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  const expected = Buffer.from(token);
  const received = Buffer.from(supplied ?? '');
  if (expected.length > 0 && received.length === expected.length && timingSafeEqual(received, expected)) {
    return null;
  }
  return Response.json({ ok: false, error: 'A valid session token is required.' }, {
    status: 401,
    headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' },
  });
}

/** Subprotocol a browser uses to present the token on a WebSocket (expo/serve-sim#173). */
export const TOKEN_SUBPROTOCOL_PREFIX = 'serve-sim.token.';

/**
 * Copy a `serve-sim.token.<token>` WebSocket subprotocol into an
 * `Authorization: Bearer` header, so the middleware's upgrade gate (which reads
 * bearer or same-origin cookie) sees it. The token is not checked here: the
 * middleware does that. A request that already carries `Authorization` is
 * left alone.
 *
 * Both the standalone CLI and Expo CLI accept plugin sockets through `ws`,
 * which names the first offered subprotocol back to the browser, so the
 * browser sees the handshake it expects. This bridge can go once the vendored
 * serve-sim reads the subprotocol itself (expo/serve-sim#173).
 */
export function upgradeHeadersWithSubprotocolToken(headers: Headers): Headers {
  const result = new Headers(headers);
  if (result.has('authorization')) return result;
  const offered = result.get('sec-websocket-protocol');
  if (!offered) return result;
  const entry = offered
    .split(',')
    .map((value) => value.trim())
    .find(
      (value) => value.startsWith(TOKEN_SUBPROTOCOL_PREFIX) && value.length > TOKEN_SUBPROTOCOL_PREFIX.length,
    );
  if (!entry) return result;
  result.set('authorization', `Bearer ${entry.slice(TOKEN_SUBPROTOCOL_PREFIX.length)}`);
  return result;
}

// One leading wildcard label over at least two more labels, as serve-sim's `--cors-origin` takes it.
const WILDCARD_HOST = /^\*\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

function isWebOrigin(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/**
 * Whether `configured` names `origin`, exactly or through a leading `*.`
 * wildcard. Mirrors serve-sim's `originMatches` so the Hub's allow list takes
 * the same values as `--cors-origin`.
 */
export function originMatches(configured: string, origin: URL): boolean {
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return false;
  }
  if (!isWebOrigin(parsed) || !isWebOrigin(origin)) return false;
  if (parsed.origin === origin.origin) return true;
  if (!WILDCARD_HOST.test(parsed.hostname)) return false;
  const suffix = parsed.hostname.slice(1).toLowerCase();
  const host = origin.hostname.toLowerCase();
  return (
    parsed.protocol === origin.protocol &&
    parsed.port === origin.port &&
    host.length > suffix.length &&
    host.endsWith(suffix)
  );
}

/**
 * Let an allow-listed cross-origin page open the exec socket. The vendored
 * exec handler closes any upgrade whose `Origin` host is not the request's
 * own host and does not consult the CORS list (expo/serve-sim#173 adds that).
 * Until that is vendored, an `Origin` that the operator allowed is rewritten
 * to the Hub's own origin so the same-host check passes. Anything else is left
 * as sent, so the handler still refuses it. The token is checked separately.
 */
export function upgradeHeadersForAllowedOrigin(
  headers: Headers,
  requestUrl: string,
  allowedOrigins: readonly string[],
): Headers {
  const result = new Headers(headers);
  const sent = result.get('origin');
  if (!sent || allowedOrigins.length === 0) return result;
  let origin: URL;
  let request: URL;
  try {
    origin = new URL(sent);
    request = new URL(requestUrl);
  } catch {
    return result;
  }
  if (origin.host === request.host) return result;
  if (!allowedOrigins.some((allowed) => originMatches(allowed, origin))) return result;
  result.set('origin', request.origin);
  return result;
}

/** Everything the middleware's upgrade gate and exec handler need from a browser handshake. */
export function upgradeHeadersForMiddleware(
  headers: Headers,
  requestUrl: string,
  allowedOrigins: readonly string[],
): Headers {
  return upgradeHeadersForAllowedOrigin(
    upgradeHeadersWithSubprotocolToken(headers),
    requestUrl,
    allowedOrigins,
  );
}
