/** Node runtime helpers for the bundled CLI. */
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createServer as createHttpServer, type IncomingMessage } from "http";
import { createServer as createNetServer } from "net";
import { WebSocketServer } from "ws";
import { createRequestListener } from "@remix-run/node-fetch-server";
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

/** Fetch-style middleware signature, matching what `simMiddleware` returns. */
type WebMiddleware = ((request: Request) => Response | undefined | Promise<Response | undefined>) & {
  /**
   * WebSocket hook (exec channel); returns true when handled. Receives the raw
   * Node `IncomingMessage` from the `upgrade` event — an upgrade has no paired
   * `ServerResponse`, so there's nothing to build a web `Request` from (its
   * abort wiring needs the response), and the handler only reads the URL +
   * headers (host/origin) anyway.
   */
  handleWebSocket?: (req: IncomingMessage, websocket: ExecWebSocket) => boolean;
};

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

  // `createRequestListener` handles the Node ↔ web Request/Response bridge,
  // including streaming bodies and aborting the request signal when the client
  // disconnects (which tears down the SSE/MJPEG child processes). The
  // middleware returns `undefined` for unclaimed routes; map that to a 404.
  const server = createHttpServer(
    createRequestListener(async (request) => {
      const response = await opts.middleware(request);
      return response ?? new Response("Not found", { status: 404 });
    }),
  );
  // The exec WebSocket channel keeps actions off the browser's per-origin
  // HTTP connection pool (which the streams below saturate with 2+ tabs).
  server.on("upgrade", (req, socket, head) => {
    if (!opts.middleware.handleWebSocket) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (websocket) => {
      const handled = opts.middleware.handleWebSocket?.(
        req,
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
