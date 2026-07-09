import { createRouter, type EmuApp, type RouterDefaults } from "./middleware.ts";
import { fromBunSocket, type BunSocketHandlers } from "./stream-socket.ts";

export type ServerOpts = RouterDefaults & { port: number };

type WsData = { serial: string; frameMeta: boolean; handlers?: BunSocketHandlers };

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Standalone Bun server: mounts the multi-device router (`createRouter`) onto
 * `Bun.serve`. HTTP requests go to `router.handleRequest`; the `/ws?device=`
 * upgrade resolves + starts the target device, then hands the accepted socket
 * to `router.attachWebSocket` through the Bun adapter, whose stashed handlers
 * the server-level `message`/`close` callbacks dispatch to. One port serves
 * every device; the client selects one with `?device=<serial>`.
 */
export async function startServer(opts: ServerOpts) {
  const { port, ...defaults } = opts;
  const router = createRouter(defaults);

  // Eagerly start the default device so it streams immediately, the readiness
  // log has something to print, and a no-device situation fails fast at boot.
  const { serial, app } = await router.ensure(defaults.serial);
  console.log(
    `${app.session.transport} ready: ${app.session.meta.deviceName} • ${app.session.meta.codecId} • ${app.session.meta.width}×${app.session.meta.height}`,
  );

  const server = Bun.serve<WsData>({
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        let resolved: { serial: string; app: EmuApp };
        try {
          resolved = await router.ensure(url.searchParams.get("device"));
        } catch (err) {
          return new Response(JSON.stringify({ ok: false, error: errMsg(err) }), {
            status: 503,
            headers: jsonHeaders,
          });
        }
        if (!resolved.app.isStreaming()) {
          return new Response(JSON.stringify(resolved.app.health()), {
            status: 503,
            headers: jsonHeaders,
          });
        }
        const frameMeta = url.searchParams.get("frame-meta") === "1";
        const ok = srv.upgrade(req, { data: { serial: resolved.serial, frameMeta } });
        if (ok) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }

      return router.handleRequest(req);
    },
    websocket: {
      open(ws) {
        router.attachWebSocket(fromBunSocket(ws), {
          serial: ws.data.serial,
          frameMeta: ws.data.frameMeta,
        });
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
    router.stopAll();
    server.stop(true);
  };

  return { server, router, serial, session: app.session, stop };
}

export type StartedServer = Awaited<ReturnType<typeof startServer>>;
export type { ScrcpySession } from "./scrcpy.ts";
