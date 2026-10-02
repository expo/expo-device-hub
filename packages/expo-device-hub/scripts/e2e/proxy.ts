import { join } from "node:path";

export type InputMode = "normal" | "refuse" | "delay-refuse";
export type WireEvent = {
  at: number;
  channel: "input" | "control";
  mode?: InputMode;
  tag?: number;
  type?: string;
  path?: string;
  connection: number;
  requestId?: number;
  option?: string;
  ok?: boolean;
  subscriptionId?: number;
  subscriptionData?: boolean;
};
type SocketData = {
  path: string;
  channel: "input" | "control" | "devices" | "agent";
  connection: number;
  upstream?: WebSocket;
  pending: Array<string | Uint8Array>;
  timer?: ReturnType<typeof setInterval>;
  closed: boolean;
};

export function startProxy(options: {
  backend: string;
  device: string;
  assets: string;
  fixtureLog: () => Promise<string>;
  restart: () => Promise<void>;
  launch: (keyboard: boolean) => Promise<void>;
  result: (result: unknown) => void;
  start: () => void;
}) {
  let mode: InputMode = "normal";
  let connections = 0;
  let controlConnections = 0;
  const events: WireEvent[] = [];
  const inputAttempts: Array<{ at: number; mode: InputMode; connection: number }> = [];
  const inputs = new Set<Bun.ServerWebSocket<SocketData>>();
  const controls = new Set<Bun.ServerWebSocket<SocketData>>();
  const all = new Set<Bun.ServerWebSocket<SocketData>>();
  const shutdown = new AbortController();
  const record = (event: WireEvent) => {
    events.push(event);
    if (events.length > 2_000) events.shift();
  };
  const reason = "Simulator input unavailable; retry after other clients disconnect";
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (
        request.method === "POST" &&
        request.headers.get("origin") &&
        request.headers.get("origin") !== url.origin
      ) {
        return new Response(null, { status: 403 });
      }
      if (url.pathname === "/_e2e/start" && request.method === "POST") {
        options.start();
        return Response.json({ ok: true });
      }
      if (url.pathname === "/_e2e/state")
        return Response.json({ mode, controlConnections, inputAttempts, events });
      if (url.pathname === "/_e2e/fixture") return new Response(await options.fixtureLog());
      if (url.pathname === "/_e2e/launch" && request.method === "POST") {
        await options.launch(((await request.json()) as { keyboard: boolean }).keyboard);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/_e2e/result" && request.method === "POST") {
        options.result(await request.json());
        return Response.json({ ok: true });
      }
      if (url.pathname === "/_e2e/input" && request.method === "POST") {
        const next = ((await request.json()) as { mode: InputMode }).mode;
        if (!["normal", "refuse", "delay-refuse"].includes(next))
          return new Response(null, { status: 400 });
        mode = next;
        for (const socket of inputs) socket.close(1013, reason);
        return Response.json({ mode });
      }
      if (url.pathname === "/_e2e/control-drop" && request.method === "POST") {
        for (const socket of controls) socket.close(1012, "E2E restart");
        return Response.json({ ok: true });
      }
      if (url.pathname === "/_e2e/restart" && request.method === "POST") {
        for (const socket of inputs) socket.close(1012, "E2E restart");
        for (const socket of controls) socket.close(1012, "E2E restart");
        await options.restart();
        return Response.json({ ok: true });
      }
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const channel =
          url.pathname === "/api/devices/ws"
            ? "devices"
            : url.pathname === "/api/argent-interactions/ws"
              ? "agent"
              : url.pathname.endsWith("/exec-ws")
                ? "control"
                : "input";
        if (
          !["devices", "agent"].includes(channel) &&
          !url.pathname.startsWith("/vendor/serve-sim/")
        ) {
          return new Response(null, { status: 404 });
        }
        if (
          server.upgrade(request, {
            data: {
              path: url.pathname + url.search,
              channel,
              connection: ++connections,
              pending: [],
              closed: false,
            },
          })
        )
          return;
        return new Response(null, { status: 400 });
      }
      if (url.pathname === "/api/new-device-options")
        return Response.json({ ios: { runtimes: [] }, android: { runtimes: [] } });
      if (url.pathname.startsWith("/vendor/serve-sim/")) {
        const path = url.pathname.replace("/vendor/serve-sim", "");
        // Discovery advertises backend-local paths. The browser resolves their
        // public vendor mount through the production client URL adapter.
        try {
          return await fetch(new Request(options.backend + path + url.search, request), {
            signal: AbortSignal.any([request.signal, shutdown.signal]),
          });
        } catch {
          // Restart faults deliberately make the backend unavailable briefly.
          return new Response("Backend unavailable", { status: 503 });
        }
      }
      if (url.pathname === "/")
        return new Response(
          `<!doctype html><html><head>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Device Hub</title><link rel="stylesheet" href="/dashboard.css"></head><body>
        <div id="root"></div><script>
        window.__EXPO_DEVICE_HUB_BASE_PATH__='';
        window.__EXPO_DEVICE_HUB_TRANSPORT__='webrtc';
        window.__EXPO_DEVICE_HUB_PLATFORM__='ios';
        </script><script type="module" src="/dashboard.js"></script></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      const name = url.pathname.slice(1);
      if (!/^[\w.-]+\.(js|css|png)$/.test(name)) return new Response(null, { status: 404 });
      const file = Bun.file(join(options.assets, name));
      return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
    },
    websocket: {
      open(socket) {
        all.add(socket);
        const data = socket.data;
        if (data.channel === "devices") {
          socket.send(
            JSON.stringify({
              type: "device-list",
              devices: {
                simulators: [
                  {
                    id: options.device,
                    name: "E2E iPhone",
                    version: "26.4",
                    platform: "ios",
                    booted: true,
                    physical: false,
                    supported: true,
                  },
                ],
                emulators: [],
              },
            }),
          );
          data.timer = setInterval(() => socket.send(JSON.stringify({ type: "heartbeat" })), 1_000);
          return;
        }
        if (data.channel === "agent") return;
        if (data.channel === "input") {
          inputs.add(socket);
          inputAttempts.push({ at: Date.now(), mode, connection: data.connection });
          if (mode === "refuse") {
            socket.close(1013, reason);
            return;
          }
          if (mode === "delay-refuse") {
            data.timer = setTimeout(() => socket.close(1013, reason), 3_000);
            return;
          }
        } else {
          controls.add(socket);
          controlConnections++;
        }
        const upstream = new WebSocket(
          options.backend.replace("http:", "ws:") + data.path.replace("/vendor/serve-sim", ""),
        );
        data.upstream = upstream;
        upstream.binaryType = "arraybuffer";
        upstream.onopen = () => {
          if (data.closed) {
            upstream.close();
            return;
          }
          for (const message of data.pending)
            upstream.send(typeof message === "string" ? message : new Uint8Array(message));
          data.pending = [];
        };
        upstream.onmessage = ({ data: message }) => {
          if (data.channel === "control") {
            try {
              const reply = JSON.parse(String(message));
              if (typeof reply.id === "number")
                record({
                  at: Date.now(),
                  channel: "control",
                  connection: data.connection,
                  requestId: reply.id,
                  ok: reply.ok === true,
                });
              if (
                typeof reply.sub === "number" &&
                typeof reply.data === "string" &&
                /^data:/m.test(reply.data)
              )
                record({
                  at: Date.now(),
                  channel: "control",
                  connection: data.connection,
                  subscriptionId: reply.sub,
                  subscriptionData: true,
                });
            } catch {}
          }
          if (!data.closed)
            socket.send(typeof message === "string" ? message : new Uint8Array(message));
        };
        upstream.onclose = (event) => {
          if (!data.closed) socket.close(event.code === 1006 ? 1011 : event.code, event.reason);
        };
        upstream.onerror = () => {
          if (!data.closed) socket.close(1011, "Upstream unavailable");
        };
      },
      message(socket, message) {
        const data = socket.data;
        if (data.channel === "devices" || data.channel === "agent") return;
        if (data.channel === "input" && typeof message !== "string") {
          let type: string | undefined;
          try {
            type = JSON.parse(new TextDecoder().decode(message.subarray(1))).type;
          } catch {}
          record({
            at: Date.now(),
            channel: "input",
            mode,
            tag: message[0],
            type,
            connection: data.connection,
          });
        } else if (data.channel === "control") {
          try {
            const parsed = JSON.parse(String(message));
            // Never retain authentication tokens or typed text in wire logs.
            if (typeof parsed.path === "string")
              record({
                at: Date.now(),
                channel: "control",
                path: parsed.path,
                subscriptionId: parsed.sub,
                connection: data.connection,
              });
            if (typeof parsed.id === "number" && parsed.ui?.option)
              record({
                at: Date.now(),
                channel: "control",
                requestId: parsed.id,
                option: parsed.ui.option,
                connection: data.connection,
              });
          } catch {}
        }
        const upstream = data.upstream;
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
        else data.pending.push(typeof message === "string" ? message : new Uint8Array(message));
      },
      close(socket) {
        socket.data.closed = true;
        clearInterval(socket.data.timer);
        socket.data.upstream?.close();
        socket.data.pending = [];
        inputs.delete(socket);
        controls.delete(socket);
        all.delete(socket);
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    snapshot: () => ({ mode, controlConnections, inputAttempts, events }),
    async close() {
      shutdown.abort();
      for (const socket of all) {
        clearInterval(socket.data.timer);
        socket.data.upstream?.close();
        socket.terminate();
      }
      server.stop(true);
      server.unref();
    },
  };
}
