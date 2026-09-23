
export interface UpgradeHandlerWebSocket {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string | Buffer): void;
  close(): void;
  on(event: "message", listener: (data: Buffer<ArrayBufferLike>) => void): void;
  on(event: "error", listener: (error?: unknown) => void): void;
  on(event: "close", listener: () => void): void;
}

export type SseSink = {
  readonly closed: boolean;
  write(chunk: string): void;
  close(): void;
};

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

export function requestHost(request: Request, url: URL): string | undefined {
  return request.headers.get("host") ?? url.host ?? undefined;
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function textResponse(value: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "text/plain; charset=utf-8");
  }
  return new Response(value, { ...init, headers });
}

export function noStoreJsonResponse(value: unknown, status = 200): Response {
  return jsonResponse(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function sseResponse(setup: (sink: SseSink) => void | (() => void)): Response {
  const textEncoder = new TextEncoder();

  let cleanup: (() => void) | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        try { cleanup?.(); } catch {}
        try { controller.close(); } catch {}
      };
      const sink: SseSink = {
        get closed() {
          return closed;
        },
        write(chunk: string) {
          if (closed) return;
          try {
            controller.enqueue(textEncoder.encode(chunk));
          } catch {
            close();
          }
        },
        close,
      };

      try {
        cleanup = setup(sink) ?? undefined;
      } catch (error) {
        closed = true;
        controller.error(error);
      }
    },
    cancel() {
      if (closed) return;
      closed = true;
      try { cleanup?.(); } catch {}
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function readTextBody(request: Request, maxBytes?: number): Promise<
  { ok: true; text: string } | { ok: false; response: Response }
> {
  if (!request.body) return { ok: true, text: "" };
  const textDecoder = new TextDecoder();
  const reader = request.body.getReader();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (maxBytes !== undefined && size > maxBytes) {
        await reader.cancel().catch(() => {});
        return {
          ok: false,
          response: jsonResponse(
            { stdout: "", stderr: "Payload Too Large", exitCode: 1 },
            { status: 413 },
          ),
        };
      }
      text += textDecoder.decode(value, { stream: true });
    }
    text += textDecoder.decode();
    return { ok: true, text };
  } finally {
    reader.releaseLock();
  }
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
function isWebOrigin(url: URL): boolean {
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
