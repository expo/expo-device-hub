import { timingSafeEqual } from "node:crypto";
import { ApiError, apiErrorResponse } from "./api/api-error.ts";

/**
 * Credential checks for a router started with a session token. They follow
 * serve-sim's `--require-token` gate, so a host that mounts both backends can
 * forward one token to each. The router checks the credential only: a host that
 * serves a browser UI owns the browser session (for example a cookie) and
 * forwards the token as a bearer header.
 */

/** A browser cannot set a header on a WebSocket, so it names the token as a subprotocol. */
export const SESSION_TOKEN_SUBPROTOCOL_PREFIX = "serve-emu.token.";

/** A client offers one token, or a stale one and the current one. More are not compared. */
const MAX_TOKEN_SUBPROTOCOLS = 4;

/**
 * Letters, digits, and `-._~` travel unchanged in a header, a URL query, a
 * cookie, and a WebSocket subprotocol, so a token made of them works for every
 * client. base64url, hex, and UUID tokens qualify. serve-sim and Expo Device
 * Hub apply the same rule.
 */
export function isUsableSessionToken(token: string): boolean {
  return /^[A-Za-z0-9._~-]+$/.test(token);
}

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  return match ? match[1]!.trim() : null;
}

function hasBearerToken(req: Request, token: string): boolean {
  const presented = bearerToken(req);
  return presented !== null && safeEqual(presented, token);
}

/**
 * An HTTP request presents the token as `Authorization: Bearer <token>`, or as
 * `?token=<token>` for a caller that cannot set a header (EventSource, `<img>`).
 */
export function requestHasSessionToken(req: Request, token: string): boolean {
  if (hasBearerToken(req, token)) return true;
  const presented = new URL(req.url).searchParams.get("token");
  return presented !== null && safeEqual(presented, token);
}

/**
 * A WebSocket upgrade presents the token as a bearer header or a
 * `serve-emu.token.<token>` subprotocol. It never takes `?token=`: proxy and
 * tunnel access logs record query strings, not headers or subprotocols.
 */
export function upgradeHasSessionToken(req: Request, token: string): boolean {
  if (hasBearerToken(req, token)) return true;
  return (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(SESSION_TOKEN_SUBPROTOCOL_PREFIX))
    .slice(0, MAX_TOKEN_SUBPROTOCOLS)
    .some((entry) => safeEqual(entry.slice(SESSION_TOKEN_SUBPROTOCOL_PREFIX.length), token));
}

/**
 * The refusal for a request without the token. It never echoes a presented
 * value. `corsHeaders` let an allowed origin read the refusal, so a client on
 * another origin sees a 401 rather than a network error.
 */
export function sessionTokenRequiredResponse(corsHeaders: Record<string, string> = {}): Response {
  return apiErrorResponse(
    new ApiError(
      401,
      "unauthorized",
      "This server requires its session token. Send it as 'Authorization: Bearer <token>'.",
      { headers: { ...corsHeaders, "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" } },
    ),
  );
}
