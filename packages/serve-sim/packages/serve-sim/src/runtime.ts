/** Node runtime helpers for the bundled CLI. */
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createServer as createHttpServer, type IncomingMessage } from "http";
import type { Socket } from "net";
import { createConnection, createServer as createNetServer, type Server as NetServer } from "net";
import { WebSocketServer } from "ws";
import { EXEC_WS_MAX_MESSAGE_BYTES } from "./exec-ws-utils";
import { type UpgradeHandlerWebSocket } from "./middleware-utils";
import {
  RequestBodyTooLargeError,
  nodeRequestToWeb,
  readRequestBodyAsync,
  writeWebResponse,
  type WebMiddleware,
} from "./runtime-utils";

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
  /** The port the server actually bound to (resolves `port: 0` to the OS-assigned port). */
  port: number;
  stop(force?: boolean): void;
}

type PreviewMiddleware = WebMiddleware & {
  handleUpgrade?: (req: IncomingMessage, socket: Socket, head: Buffer) => void;
};

function parseHttpRequestHead(buffer: Buffer): {
  method: string;
  url: string;
  httpVersion: string;
  headers: Record<string, string | string[]>;
  headEnd: number;
} | null {
  const headEnd = buffer.indexOf("\r\n\r\n");
  if (headEnd === -1) return null;
  const lines = buffer.subarray(0, headEnd).toString("latin1").split("\r\n");
  const [method, url, version] = (lines.shift() ?? "").split(" ");
  if (!method || !url || !version?.startsWith("HTTP/")) return null;
  const headers: Record<string, string | string[]> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers[name];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else if (existing != null) {
      headers[name] = [existing, value];
    } else {
      headers[name] = value;
    }
  }
  return {
    method,
    url,
    httpVersion: version.slice("HTTP/".length),
    headers,
    headEnd: headEnd + 4,
  };
}

function isWebSocketUpgrade(headers: Record<string, string | string[]>): boolean {
  const upgrade = headers.upgrade;
  const connection = headers.connection;
  const upgradeValue = Array.isArray(upgrade) ? upgrade.join(",") : upgrade ?? "";
  const connectionValue = Array.isArray(connection) ? connection.join(",") : connection ?? "";
  return /websocket/i.test(upgradeValue) && /upgrade/i.test(connectionValue);
}

function isExecWebSocketPath(url: string): boolean {
  const pathname = new URL(url, "http://serve-sim.local").pathname;
  return pathname === "/exec-ws" || pathname.endsWith("/exec-ws");
}

function proxyTcpToHttpServer(socket: Socket, firstChunk: Buffer, port: number): void {
  const upstream = createConnection(port, "127.0.0.1");
  const destroyBoth = () => {
    socket.destroy();
    upstream.destroy();
  };
  socket.on("error", destroyBoth);
  upstream.on("error", destroyBoth);
  upstream.on("connect", () => {
    upstream.write(firstChunk);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
}

function createPreviewFrontServer(
  middleware: PreviewMiddleware,
  internalPort: number,
): NetServer {
  return createNetServer((socket) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 64 * 1024) {
        socket.destroy();
        return;
      }
      const parsed = parseHttpRequestHead(buffered);
      if (!parsed) return;
      socket.removeListener("data", onData);
      if (middleware.handleUpgrade && isWebSocketUpgrade(parsed.headers) && !isExecWebSocketPath(parsed.url)) {
        const head = buffered.subarray(parsed.headEnd);
        const req = {
          method: parsed.method,
          url: parsed.url,
          headers: parsed.headers,
          httpVersion: parsed.httpVersion,
          socket,
        } as IncomingMessage;
        middleware.handleUpgrade(req, socket, head);
        return;
      }
      proxyTcpToHttpServer(socket, buffered, internalPort);
    };
    socket.on("data", onData);
    socket.on("error", () => socket.destroy());
  });
}

/** Run a fetch-style middleware as an HTTP server. */
export async function servePreview(opts: {
  port: number;
  middleware: PreviewMiddleware;
  /**
   * Interface to bind. Defaults to `127.0.0.1` so the preview is reachable
   * only from the developer's machine — the middleware exposes shell-exec
   * routes that must not be reachable from other hosts. Pass an explicit
   * value (e.g. `"0.0.0.0"`) to opt in to LAN exposure.
   */
  host?: string;
}): Promise<PreviewServer> {
  const isBun = !!process.versions.bun;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: EXEC_WS_MAX_MESSAGE_BYTES,
  });

  const internalServer = createHttpServer(
    {
      highWaterMark: 1024 * 1024 * 5,
    },
    (req, res) => {
      void (async () => {
        const request = nodeRequestToWeb(req, res, await readRequestBodyAsync(req));
        const response = await opts.middleware(request);
        await writeWebResponse(req, res, response);
      })().catch((error) => {
        if (error instanceof RequestBodyTooLargeError) {
          if (!res.headersSent) res.writeHead(413, { "Content-Type": "text/plain" });
          res.end("Payload Too Large");
          return;
        }
        console.error("Middleware error:", error);
        if (res.headersSent) {
          if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
          return;
        }
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(error instanceof Error ? error.message : "Internal Server Error");
      });
    },
  );
  internalServer.on("upgrade", (req, socket, head) => {
    const request = nodeRequestToWeb(req);
    if (opts.middleware.handleWebSocket && isExecWebSocketPath(req.url ?? "")) {
      wss.handleUpgrade(req, socket, head, (websocket) => {
        const handled = opts.middleware.handleWebSocket?.(
          request,
          websocket as unknown as UpgradeHandlerWebSocket,
        );
        if (!handled) websocket.close();
      });
      return;
    }
    if (opts.middleware.handleUpgrade) {
      opts.middleware.handleUpgrade(req, socket as Socket, head);
      return;
    }
    socket.destroy();
  });

  // MJPEG streams + SSE channels are long-lived; clear the default 2-min
  // socket timeout so they don't get torn down mid-stream.
  internalServer.keepAliveTimeout = 0;
  internalServer.headersTimeout = 0;
  internalServer.requestTimeout = 0;
  internalServer.timeout = 0;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error & { code?: string }) => {
      internalServer.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      internalServer.removeListener("error", onError);
      resolve();
    };
    internalServer.once("error", onError);
    internalServer.once("listening", onListening);
    if (isBun) {
      internalServer.listen(0, "127.0.0.1");
    } else {
      internalServer.listen(opts.port, opts.host ?? "127.0.0.1");
    }
  });

  const internalAddress = internalServer.address();
  if (!internalAddress || typeof internalAddress === "string") {
    internalServer.close();
    throw new Error("Failed to bind preview HTTP server");
  }

  let maybeFrontServer: NetServer | undefined;
  let publicPort = internalAddress.port;
  if (isBun) {
    // Work around Bun node:http upgrade forwarding issues by binding the public
    // port with a small TCP front server and proxying regular HTTP internally.
    const frontServer = createPreviewFrontServer(opts.middleware, internalAddress.port);
    maybeFrontServer = frontServer;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error & { code?: string }) => {
        frontServer.removeListener("listening", onListening);
        internalServer.close(() => reject(err));
      };
      const onListening = () => {
        frontServer.removeListener("error", onError);
        resolve();
      };
      frontServer.once("error", onError);
      frontServer.once("listening", onListening);
      frontServer.listen(opts.port, opts.host ?? "127.0.0.1");
    });
    const frontAddress = frontServer.address();
    if (frontAddress && typeof frontAddress !== "string") {
      publicPort = frontAddress.port;
    }
  }

  return {
    port: publicPort,
    stop: () => {
      wss.close();
      internalServer.close();
      maybeFrontServer?.close();
    },
  };
}
