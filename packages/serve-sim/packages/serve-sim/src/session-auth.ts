import { createHash, timingSafeEqual } from "node:crypto";

import { unauthorizedPreviewPage } from "./unauthorized-page";

export interface SessionAuthReq {
  method?: string;
  headers: {
    origin?: string | string[];
    host?: string | string[];
    authorization?: string | string[];
    [key: string]: string | string[] | undefined;
  };
}

export interface SessionAuthRes {
  writeHead: (status: number, headers?: Record<string, string>) => unknown;
  end: (body?: string) => unknown;
}

export function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match ? match[1]!.trim() : null;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export const ACCESS_COOKIE = "serve_sim_access";

// Cookies ignore the port, so two serve-sims on one host would overwrite each other's.
export function accessCookieName(sessionToken: string): string {
  const suffix = createHash("sha256").update(sessionToken).digest("hex").slice(0, 8);
  return `${ACCESS_COOKIE}_${suffix}`;
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      // Runs on the synchronous upgrade path, where an uncaught URIError would crash the process.
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// EAS terminates TLS at the tunnel, so the forwarded scheme is the only signal we get.
function isHttpsRequest(headers: SessionAuthReq["headers"]): boolean {
  const forwarded = headerValue(headers["x-forwarded-proto"]);
  if (forwarded) return forwarded.split(",", 1)[0]!.trim().toLowerCase() === "https";
  return false;
}

// A cross-site frame never receives a Lax cookie. Partitioned keys the cookie to the embedding
// site, so another site's frame gets none of it and third-party-cookie blocking still stores it.
// Both need Secure, so a plain-http server stays on Lax.
function accessCookie(
  sessionToken: string,
  basePath: string,
  secure: boolean,
  embedded: boolean,
): string {
  const partitioned = secure && embedded;
  return [
    `${accessCookieName(sessionToken)}=${encodeURIComponent(sessionToken)}`,
    "HttpOnly",
    partitioned ? "SameSite=None" : "SameSite=Lax",
    `Path=${basePath || "/"}`,
    ...(secure ? ["Secure"] : []),
    ...(partitioned ? ["Partitioned"] : []),
  ].join("; ");
}

// A cookie rides along on any same-site page's requests, so cookie auth must also prove the
// origin. A bearer or query token is presented deliberately and needs no such check.
function isSameOriginRequest(headers: SessionAuthReq["headers"]): boolean {
  const site = headerValue(headers["sec-fetch-site"]);
  if (site !== undefined) return site === "same-origin" || site === "none";
  const origin = headerValue(headers.origin);
  if (!origin) return true;
  try {
    return new URL(origin).host === headerValue(headers.host);
  } catch {
    return false;
  }
}

function isDocumentNavigation(headers: SessionAuthReq["headers"]): boolean {
  const dest = headerValue(headers["sec-fetch-dest"]);
  if (dest !== undefined) return dest === "document";
  return (headerValue(headers["accept"]) ?? "").includes("text/html");
}

function prefersHtmlResponse(req: SessionAuthReq): boolean {
  return isDocumentNavigation(req.headers) || isEmbeddedNavigation(req);
}

function isEmbeddedNavigation(req: SessionAuthReq): boolean {
  return isNavigation(req) && headerValue(req.headers["sec-fetch-dest"]) === "iframe";
}

function isNavigation(req: SessionAuthReq): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const mode = headerValue(req.headers["sec-fetch-mode"]);
  return mode === undefined || mode === "navigate";
}

// A Lax cookie only rides a cross-site request when it is one of these, and that page cannot read
// the response. The hop after the token redirect still reports cross-site, so without this the
// dashboard link 401s on first load.
function isTopLevelNavigation(req: SessionAuthReq): boolean {
  return isNavigation(req) && isDocumentNavigation(req.headers);
}

// Returns false when the request has been answered and must stop.
export function assertPreviewAccess(
  req: SessionAuthReq & { url?: string },
  res: SessionAuthRes,
  sessionToken: string,
  opts: {
    required: boolean;
    basePath: string;
    htmlHeaders?: Record<string, string>;
  },
): boolean {
  if (!opts.required) return true;

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const fromQuery = url.searchParams.get("token");
  if (fromQuery && safeEqualString(fromQuery, sessionToken)) {
    // A page load trades the token for a cookie so it leaves the URL and the page's own requests
    // carry it. A cross-origin API/SSE caller can send neither header nor cookie, so it is served
    // the query token directly.
    if (!prefersHtmlResponse(req)) return true;
    const embedded = isEmbeddedNavigation(req);
    url.searchParams.delete("token");
    res.writeHead(302, {
      // A leading "//" would be read as an absolute cross-origin URL by the browser.
      Location: `${url.pathname.replace(/^\/+/, "/")}${url.search}`,
      "Set-Cookie": accessCookie(sessionToken, opts.basePath, isHttpsRequest(req.headers), embedded),
      "Cache-Control": "no-store, private",
    });
    res.end();
    return false;
  }

  const fromBearer = bearerToken(headerValue(req.headers.authorization));
  if (fromBearer && safeEqualString(fromBearer, sessionToken)) return true;
  const fromCookie = cookieValue(headerValue(req.headers.cookie), accessCookieName(sessionToken));
  if (
    fromCookie &&
    safeEqualString(fromCookie, sessionToken) &&
    (isSameOriginRequest(req.headers) || isTopLevelNavigation(req) || isEmbeddedNavigation(req))
  ) {
    return true;
  }

  if (prefersHtmlResponse(req)) {
    res.writeHead(401, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, private",
      ...opts.htmlHeaders,
    });
    res.end(unauthorizedPreviewPage({ rejectedToken: !!fromQuery }));
    return false;
  }
  res.writeHead(401, { "Content-Type": "text/plain", "Cache-Control": "no-store, private" });
  res.end(
    "Unauthorized. This serve-sim was started with --require-token, so the preview needs the access " +
      "token it printed at startup. Open the preview link the CLI logged, which carries the token, " +
      "or send the token as `Authorization: Bearer <token>`.\n",
  );
  return false;
}

export const TOKEN_SUBPROTOCOL_PREFIX = "serve-sim.token.";

// A CR or LF here would forge a header line in the handshake.
const SUBPROTOCOL_TOKEN = /^[!#$%&'*+\-.0-9A-Za-z^_`|~]+$/;

function offeredTokenSubprotocols(headers: SessionAuthReq["headers"]): string[] {
  const raw = headers["sec-websocket-protocol"];
  const offered = Array.isArray(raw) ? raw.join(",") : raw;
  if (!offered) return [];
  return offered
    .split(",")
    .map((entry) => entry.trim())
    .filter((value) =>
      value.startsWith(TOKEN_SUBPROTOCOL_PREFIX)
      && value.length > TOKEN_SUBPROTOCOL_PREFIX.length
      && SUBPROTOCOL_TOKEN.test(value)
    );
}

export function acceptedTokenSubprotocol(
  headers: SessionAuthReq["headers"],
  sessionToken: string,
): string | null {
  return offeredTokenSubprotocols(headers).find((value) =>
    safeEqualString(value.slice(TOKEN_SUBPROTOCOL_PREFIX.length), sessionToken)
  ) ?? null;
}

const UPGRADE_AUTH_HEADERS = [
  "authorization",
  "cookie",
  "origin",
  "host",
  "sec-fetch-site",
  "sec-websocket-protocol",
] as const;

export function upgradeAuthHeaders(
  source: SessionAuthReq["headers"] | Request,
): SessionAuthReq["headers"] {
  const read = source instanceof Request
    ? (name: string) => source.headers.get(name) ?? undefined
    : (name: string) => source[name];
  const headers: SessionAuthReq["headers"] = {};
  for (const name of UPGRADE_AUTH_HEADERS) headers[name] = read(name);
  return headers;
}

// No `?token=` fallback, so this credential never reaches a request URL or a proxy log.
export function assertUpgradeAccess(
  req: SessionAuthReq["headers"],
  sessionToken: string,
  opts: { required: boolean },
): boolean {
  if (!opts.required) return true;
  const fromBearer = bearerToken(headerValue(req.authorization));
  if (fromBearer && safeEqualString(fromBearer, sessionToken)) return true;
  if (acceptedTokenSubprotocol(req, sessionToken)) return true;
  const fromCookie = cookieValue(headerValue(req.cookie), accessCookieName(sessionToken));
  return !!fromCookie && safeEqualString(fromCookie, sessionToken) && isSameOriginRequest(req);
}
