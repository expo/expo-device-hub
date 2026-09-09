
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

// Echoes the request Origin (never a wildcard) when it's loopback or allowlisted.
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
  // URL() keeps IPv6 hosts bracketed ("[::1]"); strip them before comparing.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  // Compare on canonical origins (default port dropped, no trailing slash, host lowercased) so a
  // configured `https://expo.dev:443` or `https://expo.dev/` still matches the browser's Origin.
  // Malformed configured values throw in URL() and are skipped.
  const allowed = allowedOrigins.some((o) => {
    try {
      return new URL(o).origin === parsed.origin;
    } catch {
      return false;
    }
  });
  if (isLoopback || allowed) {
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return {};
}
