export type BrowserOriginPolicy = {
  allowedOrigins?: readonly string[];
};

export const WEBRTC_CORS_METHODS = "POST, OPTIONS";
export const WEBRTC_CORS_HEADERS = "Authorization, Content-Type";
/** Every method a router route takes, named in a preflight answer for any route. */
export const ROUTER_CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname).toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function normalizedHttpOrigin(origin: string): string | null {
  if (origin === "*") return origin;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function parseAllowedOrigins(value: string): string[] {
  const origins = value.split(",").map((origin) => origin.trim()).filter(Boolean);
  const normalized = origins.map(normalizedHttpOrigin);
  if (normalized.length === 0 || normalized.some((origin) => origin === null)) {
    throw new Error("--allow-origin expects one or more comma-separated http(s) origins, or *.");
  }
  return normalized as string[];
}

// @ref LLP 0003#cors — the origin shapes serve-sim's `--cors-origin` takes, so one list fits both
// A wildcard needs two labels after the star, which stops a bare TLD like `*.com`.
const WILDCARD_HOST = /^\*\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/**
 * Whether `configured` names `origin`, exactly or through a leading `*.` wildcard. A copy of
 * serve-sim's `originMatches`: canonical origins compare, and a wildcard covers subdomains only,
 * never the bare host, with the same scheme and port.
 */
function originMatches(configured: string, origin: URL): boolean {
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
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

function isConfiguredOrigin(normalizedOrigin: string, allowedOrigins: readonly string[]): boolean {
  if (allowedOrigins.includes("*")) return true;
  const origin = new URL(normalizedOrigin);
  return allowedOrigins.some((allowed) => originMatches(allowed, origin));
}

export function isAllowedBrowserOrigin(
  req: Request,
  policy: BrowserOriginPolicy = {},
): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const normalizedOrigin = normalizedHttpOrigin(origin);
  if (!normalizedOrigin) return false;

  if (isConfiguredOrigin(normalizedOrigin, policy.allowedOrigins ?? [])) return true;

  const target = new URL(req.url);
  if (normalizedOrigin === target.origin) return true;

  const originUrl = new URL(normalizedOrigin);
  return isLoopbackHostname(originUrl.hostname) && isLoopbackHostname(target.hostname);
}

/**
 * Require an exact origin match for browser requests that mutate state.
 * Origin-less CLI/agent requests remain eligible for the surrounding auth
 * policy, while explicitly configured browser origins are also accepted.
 */
export function isAllowedMutationOrigin(
  req: Request,
  policy: BrowserOriginPolicy = {},
): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const normalizedOrigin = normalizedHttpOrigin(origin);
  if (!normalizedOrigin) return false;

  return (
    isConfiguredOrigin(normalizedOrigin, policy.allowedOrigins ?? []) ||
    normalizedOrigin === new URL(req.url).origin
  );
}

export function corsHeadersForRequest(
  req: Request,
  policy: BrowserOriginPolicy = {},
  methods = WEBRTC_CORS_METHODS,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": WEBRTC_CORS_HEADERS,
    "Access-Control-Allow-Methods": methods,
    "Cache-Control": "no-store",
  };
  const origin = req.headers.get("origin");
  if (!origin) return headers;
  if (!isAllowedBrowserOrigin(req, policy)) return headers;

  const normalizedOrigin = normalizedHttpOrigin(origin);
  if (!normalizedOrigin) return headers;
  headers["Access-Control-Allow-Origin"] = policy.allowedOrigins?.includes("*")
    ? "*"
    : normalizedOrigin;
  headers["Vary"] = "Origin";
  return headers;
}

/**
 * `response` with the CORS policy for `req`, which the router puts on every route, as
 * serve-sim's middleware does. `Vary: Origin` goes on every response, even one whose origin
 * is refused, so a cache never replays a copy without the policy to an allowed origin.
 */
export function withCorsPolicy(
  req: Request,
  response: Response,
  policy: BrowserOriginPolicy = {},
): Response {
  // A copy, because a response's headers may be immutable, as a redirect's are.
  const headers = new Headers(response.headers);
  const vary = headers.get("vary")?.split(",").map((name) => name.trim().toLowerCase()) ?? [];
  if (!vary.includes("origin") && !vary.includes("*")) headers.append("Vary", "Origin");
  const allowOrigin = corsHeadersForRequest(req, policy)["Access-Control-Allow-Origin"];
  if (allowOrigin) headers.set("Access-Control-Allow-Origin", allowOrigin);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
