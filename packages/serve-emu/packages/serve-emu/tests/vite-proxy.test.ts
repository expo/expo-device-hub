import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import {
  createBackendProxy,
  DEFAULT_BACKEND_ORIGIN,
  DEFAULT_UI_PORT,
} from "../vite.config.ts";

describe("createBackendProxy", () => {
  test("keeps the existing Vite development port", () => {
    expect(DEFAULT_UI_PORT).toBe(5173);
  });

  test("uses the default local backend", () => {
    expect(createBackendProxy()).toEqual({
      "/api": { target: DEFAULT_BACKEND_ORIGIN, changeOrigin: false },
      "/health": { target: DEFAULT_BACKEND_ORIGIN, changeOrigin: false },
      "/webrtc": { target: DEFAULT_BACKEND_ORIGIN, changeOrigin: false },
      "/ws": {
        target: "ws://localhost:3300",
        changeOrigin: false,
        ws: true,
        rewriteWsOrigin: false,
      },
    });
  });

  test("uses a custom HTTP backend for all proxy routes", () => {
    expect(createBackendProxy("http://127.0.0.1:4300/")).toEqual({
      "/api": { target: "http://127.0.0.1:4300", changeOrigin: false },
      "/health": { target: "http://127.0.0.1:4300", changeOrigin: false },
      "/webrtc": {
        target: "http://127.0.0.1:4300",
        changeOrigin: false,
      },
      "/ws": {
        target: "ws://127.0.0.1:4300",
        changeOrigin: false,
        ws: true,
        rewriteWsOrigin: false,
      },
    });
  });

  test("derives a secure WebSocket target from HTTPS", () => {
    expect(createBackendProxy("https://device.example:8443")["/ws"]).toEqual({
      target: "wss://device.example:8443",
      changeOrigin: false,
      ws: true,
      rewriteWsOrigin: false,
    });
  });

  test.each([
    "",
    "localhost:3300",
    "ftp://localhost:3300",
    "http://user@localhost:3300",
    "http://user:secret@localhost:3300",
    "http://localhost:3300/api",
    "http://localhost:3300?token=secret",
    "http://localhost:3300#fragment",
  ])("rejects invalid backend origin %s", (origin) => {
    expect(() => createBackendProxy(origin)).toThrow();
  });
});

async function availablePort(): Promise<number> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("port probe"),
  });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) {
    throw new Error("Port probe did not expose a TCP port");
  }
  return port;
}

async function startViteCli(
  backendOrigin: string,
  port: number,
): Promise<ChildProcess> {
  const packageDirectory = resolve(import.meta.dir, "..");
  const viteCli = resolve(packageDirectory, "node_modules/vite/bin/vite.js");
  const child = spawn(
    "node",
    [viteCli, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: packageDirectory,
      env: {
        ...process.env,
        NO_COLOR: "1",
        SERVE_EMU_BACKEND_ORIGIN: backendOrigin,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnError) {
      await stopProcess(child).catch(() => undefined);
      throw new Error(`Failed to start Vite CLI: ${spawnError.message}`);
    }
    if (processHasExited(child)) {
      throw new Error(
        `Vite exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode}):\n${output}`,
      );
    }
    try {
      const response = await fetch(origin, {
        signal: AbortSignal.timeout(500),
      });
      await response.body?.cancel();
      return child;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }

  await stopProcess(child);
  throw new Error(`Timed out waiting for Vite CLI:\n${output}`);
}

function processHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForProcessExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (processHasExited(child)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let settled = false;
    const settle = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolveExit(exited);
    };
    const onExit = () => settle(true);
    const timeout = setTimeout(() => settle(false), timeoutMs);
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || processHasExited(child)) return;
  child.kill("SIGTERM");
  if (await waitForProcessExit(child, 2_000)) return;
  if (!processHasExited(child)) {
    child.kill("SIGKILL");
  }
  if (await waitForProcessExit(child, 2_000)) return;
  throw new Error("Vite CLI process did not exit after SIGKILL");
}

function receiveWebSocketMessage(url: string, origin: string): Promise<string> {
  return new Promise((resolveMessage, reject) => {
    const WebSocketWithHeaders = WebSocket as unknown as new (
      url: string | URL,
      options?: Bun.WebSocketOptions,
    ) => WebSocket;
    const socket = new WebSocketWithHeaders(url, { headers: { origin } });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error("Timed out waiting for the proxied WebSocket message"));
    }, 5_000);

    socket.addEventListener("message", (event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      resolveMessage(String(event.data));
    });
    socket.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error("Proxied WebSocket connection failed"));
    });
  });
}

interface FakeSocketData {
  path: string;
  search: string;
  host: string | null;
  origin: string | null;
}

test(
  "the Vite CLI proxies API, health, and WebSocket traffic to a non-default backend",
  async () => {
    const backend = Bun.serve<FakeSocketData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname === "/api/echo" && request.method === "POST") {
          return request.json().then((body) =>
            Response.json({
              method: request.method,
              path: url.pathname,
              host: request.headers.get("host"),
              origin: request.headers.get("origin"),
              body,
            }),
          );
        }
        if (url.pathname === "/health" && request.method === "GET") {
          return Response.json({ status: "ok", port: server.port });
        }
        if (
          url.pathname === "/ws" &&
          server.upgrade(request, {
            data: {
              path: url.pathname,
              search: url.search,
              host: request.headers.get("host"),
              origin: request.headers.get("origin"),
            },
          })
        ) {
          return;
        }
        return new Response("Not found", { status: 404 });
      },
      websocket: {
        open(socket) {
          socket.send(JSON.stringify(socket.data));
        },
        message() {},
      },
    });

    let vite: ChildProcess | undefined;
    try {
      const vitePort = await availablePort();
      vite = await startViteCli(
        `http://127.0.0.1:${backend.port}`,
        vitePort,
      );
      const origin = `http://127.0.0.1:${vitePort}`;

      const apiResponse = await fetch(`${origin}/api/echo`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ value: 42 }),
        signal: AbortSignal.timeout(5_000),
      });
      expect(apiResponse.status).toBe(200);
      expect(await apiResponse.json()).toEqual({
        method: "POST",
        path: "/api/echo",
        host: new URL(origin).host,
        origin,
        body: { value: 42 },
      });

      const healthResponse = await fetch(`${origin}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toEqual({
        status: "ok",
        port: backend.port,
      });

      const message = await receiveWebSocketMessage(
        `${origin.replace("http:", "ws:")}/ws?source=vite`,
        origin,
      );
      expect(JSON.parse(message)).toEqual({
        path: "/ws",
        search: "?source=vite",
        host: new URL(origin).host,
        origin,
      });
    } finally {
      await stopProcess(vite);
      await backend.stop(true);
    }
  },
  20_000,
);
