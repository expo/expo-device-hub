export type BrowserOriginPolicy = {
  allowedOrigins?: readonly string[];
};

export const WEBRTC_CORS_METHODS = "POST, OPTIONS";
export const WEBRTC_CORS_HEADERS = "Authorization, Content-Type";

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

export function isAllowedBrowserOrigin(
  req: Request,
  policy: BrowserOriginPolicy = {},
): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const normalizedOrigin = normalizedHttpOrigin(origin);
  if (!normalizedOrigin) return false;

  const allowedOrigins = policy.allowedOrigins ?? [];
  if (allowedOrigins.includes("*") || allowedOrigins.includes(normalizedOrigin)) return true;

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

  const allowedOrigins = policy.allowedOrigins ?? [];
  return (
    allowedOrigins.includes("*") ||
    allowedOrigins.includes(normalizedOrigin) ||
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
