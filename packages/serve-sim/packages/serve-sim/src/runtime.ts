/** Node runtime helpers for the bundled CLI. */
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "http";
import { createServer as createNetServer } from "net";
import { once } from "events";
import { Readable } from "stream";
import { WebSocketServer } from "ws";
import { EXEC_WS_MAX_MESSAGE_BYTES, type ExecWebSocket } from "./exec-ws";

export function dirnameOf(metaUrl: string): string {
  return dirname(fileURLToPath(metaUrl));
}

/** Block the current thread for `ms` milliseconds without busy-waiting. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Briefly bind to `port` to test whether it's available. */
export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port);
  });
}

export interface PreviewServer {
  stop(force?: boolean): void;
}

type RequestInitWithDuplex = RequestInit & { duplex?: "half" };

/** Fetch-style middleware signature, matching what `simMiddleware` returns. */
type WebMiddleware = ((request: Request) => Response | undefined | Promise<Response | undefined>) & {
  /** WebSocket hook (exec channel); returns true when handled. */
  handleWebSocket?: (request: Request, websocket: ExecWebSocket) => boolean;
};

function nodeRequestToWeb(req: IncomingMessage, res?: ServerResponse): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const host = headers.get("host") ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const controller = new AbortController();
  res?.on("close", () => controller.abort());

  const init: RequestInitWithDuplex = {
    method: req.method,
    headers,
    signal: controller.signal,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function writeWebResponse(
  originalReq: IncomingMessage,
  res: ServerResponse,
  response: Response | undefined,
): Promise<void> {
  if (!response) {
    if (!res.headersSent) res.statusCode = 404;
    res.end("Not found");
    return;
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (originalReq.method === "HEAD" || !response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  let closed = false;
  const onClose = () => {
    closed = true;
    void reader.cancel().catch(() => {});
  };
  res.once("close", onClose);
  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await Promise.race([once(res, "drain"), once(res, "close")]);
        if (closed || res.destroyed) break;
      }
    }
    if (!res.destroyed) res.end();
  } catch (error) {
    if (!res.destroyed) {
      res.destroy(error instanceof Error ? error : undefined);
    }
  } finally {
    res.off("close", onClose);
    reader.releaseLock();
  }
}

/** Run a fetch-style middleware as an HTTP server. */
export async function servePreview(opts: {
  port: number;
  middleware: WebMiddleware;
  /**
   * Interface to bind. Defaults to `127.0.0.1` so the preview is reachable
   * only from the developer's machine — the middleware exposes shell-exec
   * routes that must not be reachable from other hosts. Pass an explicit
   * value (e.g. `"0.0.0.0"`) to opt in to LAN exposure.
   */
  host?: string;
}): Promise<PreviewServer> {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: EXEC_WS_MAX_MESSAGE_BYTES,
  });

  const server = createHttpServer((req, res) => {
    void (async () => {
      const request = nodeRequestToWeb(req, res);
      const response = await opts.middleware(request);
      await writeWebResponse(req, res, response);
    })().catch((error) => {
      if (res.headersSent) {
        if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : "Internal Server Error");
    });
  });
  // The exec WebSocket channel keeps actions off the browser's per-origin
  // HTTP connection pool (which the streams below saturate with 2+ tabs).
  server.on("upgrade", (req, socket, head) => {
    if (!opts.middleware.handleWebSocket) {
      socket.destroy();
      return;
    }
    const request = nodeRequestToWeb(req);
    wss.handleUpgrade(req, socket, head, (websocket) => {
      const handled = opts.middleware.handleWebSocket?.(
        request,
        websocket as unknown as ExecWebSocket,
      );
      if (!handled) websocket.close();
    });
  });
  // MJPEG streams + SSE log channel are long-lived; clear the default 2-min
  // socket timeout so they don't get torn down mid-stream.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.timeout = 0;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error & { code?: string }) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(opts.port, opts.host ?? "127.0.0.1");
  });

  return {
    stop: () => {
      wss.close();
      server.close();
    },
  };
}
