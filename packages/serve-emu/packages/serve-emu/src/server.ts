import { createApp, type AppOptions } from "./middleware.ts";
import { fromBunSocket, type BunSocketHandlers } from "./stream-socket.ts";

export type ServerOpts = AppOptions & { port: number };

type WsData = { frameMeta: boolean; handlers?: BunSocketHandlers };

/**
 * Standalone Bun server: mounts the runtime-agnostic app core (`createApp`) onto
 * `Bun.serve`. HTTP requests go to `app.handleRequest`; the `/ws` upgrade hands
 * the accepted socket to `app.attachWebSocket` through the Bun adapter, whose
 * stashed handlers the server-level `message`/`close` callbacks dispatch to.
 */
export async function startServer(opts: ServerOpts) {
  const app = await createApp(opts);
  console.log(
    `scrcpy ready: ${app.session.meta.deviceName} • ${app.session.meta.codecId} • ${app.session.meta.width}×${app.session.meta.height}`,
  );

  const server = Bun.serve<WsData>({
    port: opts.port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (!app.isStreaming()) {
          return new Response(JSON.stringify(app.health()), {
            status: 503,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }
        const frameMeta = url.searchParams.get("frame-meta") === "1";
        const ok = srv.upgrade(req, { data: { frameMeta } });
        if (ok) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }

      return app.handleRequest(req);
    },
    websocket: {
      open(ws) {
        app.attachWebSocket(fromBunSocket(ws), { frameMeta: ws.data.frameMeta });
      },
      message(ws, raw) {
        if (typeof raw === "string") ws.data.handlers?.message?.(raw);
      },
      close(ws) {
        ws.data.handlers?.close?.();
      },
    },
  });

  const stop = () => {
    app.stop();
    server.stop(true);
  };

  return { server, session: app.session, stop };
}

export type StartedServer = Awaited<ReturnType<typeof startServer>>;
export type { ScrcpySession } from "./scrcpy.ts";
