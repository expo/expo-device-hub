
export interface UpgradeHandlerWebSocket {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string | Buffer): void;
  close(): void;
  on(event: "message", listener: (data: Buffer<ArrayBufferLike>) => void): void;
  on(event: "error", listener: (error?: unknown) => void): void;
  on(event: "close", listener: () => void): void;
}

export function claimHelperHidSocket(
  request: Request,
  websocket: UpgradeHandlerWebSocket,
  { helperProxyTarget, fallbackDevice, resolveSession }: {
    helperProxyTarget(rawUrl: string): { device: string | null; upstreamPath: string } | null;
    fallbackDevice: string | null;
    resolveSession: {
      (device: string): { attachHidSocket(ws: UpgradeHandlerWebSocket): void };
    };
  },
): boolean {
  const url = new URL(request.url, "http://serve-sim.local");
  const target = helperProxyTarget(`${url.pathname}${url.search}`);
  if (!target || target.upstreamPath !== "/ws") return false;
  const device = target.device ?? fallbackDevice ?? null;
  if (!device) {
    websocket.close();
    return true;
  }
  let session: { attachHidSocket(ws: UpgradeHandlerWebSocket): void };
  try {
    session = resolveSession(device);
  } catch {
    websocket.close(); // not booted / capture unavailable
    return true;
  }
  session.attachHidSocket(websocket);
  return true;
}

/** Hosts where reaching the port already means being on the machine. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}

// A wildcard is only as narrow as the host the caller names: `*.github.io` and `*.co.uk` both
// pass. Two labels after the star, so the rule stops a bare TLD like `*.com`, nothing more.
const WILDCARD_HOST = /^\*\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/**
 * Whether `configured` names `origin`, either exactly or through a leading `*.` wildcard.
 * Accepts the same shapes the frame policy does, so `--cors-origin` and `--frame-ancestor`
 * take the same values.
 * Comparison is on canonical origins (default port dropped, no trailing slash, host lowercased),
 * so a configured `https://expo.dev:443` or `https://expo.dev/` still matches a browser's Origin.
 * A wildcard covers subdomains only, never the bare host, matching CSP's frame-ancestors.
 */
export function originMatches(configured: string, origin: URL): boolean {
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return false;
  }
  // Ahead of the exact match, not just the wildcard: every opaque scheme serializes to the one
  // string "null", so `chrome-extension://a` and `foo://evil` would otherwise compare equal.
  if (!isWebOrigin(parsed)) return false;
  if (parsed.origin === origin.origin) return true;
  if (!WILDCARD_HOST.test(parsed.hostname)) return false;
  const suffix = parsed.hostname.slice(1).toLowerCase();
  const host = origin.hostname.toLowerCase();
  return (
    parsed.protocol === origin.protocol
    && parsed.port === origin.port
    && host.length > suffix.length
    && host.endsWith(suffix)
  );
}

/** The schemes a browser sends a CORS Origin for. Anything else serializes to "null". */
export function isWebOrigin(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

/** Echoes the canonical request Origin (never a wildcard) when it's loopback or allowlisted. */
export function corsAllowOriginHeaders(
  origin: string | null | undefined,
  allowedOrigins: readonly string[],
): Record<string, string> {
  if (!origin) return {};
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return {};
  }
  // `foo://localhost` is a loopback host on a scheme no browser sends, and it canonicalizes to
  // "null" — the one value a sandboxed document would read back as its own.
  if (!isWebOrigin(parsed)) return {};
  // URL() keeps IPv6 hosts bracketed ("[::1]"); strip them before comparing.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isLoopbackHost(host) || allowedOrigins.some((o) => originMatches(o, parsed))) {
    return { "Access-Control-Allow-Origin": parsed.origin };
  }
  return {};
}

/**
 * True when a browser may use a route that reads user data: the page's own origin, or an origin
 * CORS already allows (loopback or `--cors-origin`). Browsers send Origin on every POST and PUT,
 * so a request without one is refused.
 */
export function isAllowedOrigin(
  origin: string | null | undefined,
  host: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (!isWebOrigin(parsed)) return false;
  if (host && parsed.host === host.toLowerCase()) return true;
  return "Access-Control-Allow-Origin" in corsAllowOriginHeaders(origin, allowedOrigins);
}

// Same wildcard rule as WILDCARD_HOST, plus the bare host and IPv6 shapes a frame source may use.
const FRAMEABLE_ORIGIN = /^https?:\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+|\*\.[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?$/i;

/**
 * Who may frame a gated preview. Browsers that ignore the Partitioned cookie attribute would
 * otherwise let any site embed one and drive it. The caller chooses the origins; this only
 * refuses shapes that would widen the policy beyond what it names.
 */
export function frameAncestorsPolicy(allowedOrigins: string[]): string {
  const origins = allowedOrigins.flatMap((allowed) => {
    try {
      const { origin } = new URL(allowed);
      return FRAMEABLE_ORIGIN.test(origin) ? [origin] : [];
    } catch {
      return [];
    }
  });
  return ["frame-ancestors", "'self'", ...origins].join(" ");
}
