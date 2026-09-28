import { fork, spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { createServer, connect, type Socket } from "net";
import { join } from "path";
import { dirnameOf } from "./runtime.js";
import { relaySocket } from "./simstream-pipe.js";

/**
 * The simstream video engine (`--codec simstream`): a separate native process per device that
 * captures the simulator render-locked, encodes with VideoToolbox low-latency rate control per
 * viewer, and streams H.264 over a WebSocket with per-viewer delay-based bitrate control.
 * serve-sim keeps input, tools and UI; the browser reaches the engine through the same-origin
 * `/helper/<udid>/simstream` socket, which is piped to the engine's loopback port.
 */
type Engine = { process: ChildProcess; port: Promise<number> };

const engines = new Map<string, Engine>();

export function simstreamEngineBinary(): string {
  return process.env.SERVE_SIM_SIMSTREAM_BIN
    ?? join(dirnameOf(import.meta.url), "..", "dist", "bin", "simstream-engine");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`simstream engine did not listen on ${port}`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

/** Starts (once) the engine for a device and resolves with its loopback port. */
export function ensureSimstreamEngine(udid: string): Promise<number> {
  const existing = engines.get(udid);
  if (existing && existing.process.exitCode === null) return existing.port;

  const binary = simstreamEngineBinary();
  if (!existsSync(binary)) {
    return Promise.reject(new Error(`simstream engine not built (${binary}); run engine/build.sh`));
  }
  let child!: ChildProcess;
  const port = freePort().then(async (port) => {
    child = spawn(binary, ["--udid", udid, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (d) => process.env.SERVE_SIM_DEBUG_SIMSTREAM && process.stderr.write(d));
    child.stderr?.on("data", (d) => process.env.SERVE_SIM_DEBUG_SIMSTREAM && process.stderr.write(d));
    child.once("exit", () => { if (engines.get(udid)?.process === child) engines.delete(udid); });
    engines.set(udid, { process: child, port: Promise.resolve(port) });
    await waitForPort(port, 15_000);
    return port;
  });
  engines.set(udid, { process: { exitCode: null } as ChildProcess, port });
  return port;
}

/**
 * Pipes an upgraded browser WebSocket to the device's engine, rewriting the request path to the
 * engine's `/stream`. The engine speaks plain RFC 6455, so the handshake passes through untouched.
 */
export async function pipeSimstreamUpgrade(
  udid: string,
  req: { method?: string; headers: Record<string, string | string[] | undefined>; rawHeaders?: string[] },
  socket: Socket,
  head: Buffer,
): Promise<void> {
  let port: number;
  try {
    port = await ensureSimstreamEngine(udid);
  } catch (error) {
    socket.end(`HTTP/1.1 503 Service Unavailable\r\n\r\n${String(error)}`);
    return;
  }
  const lines = [`GET /stream HTTP/1.1`];
  const raw = req.rawHeaders ?? [];
  for (let i = 0; i + 1 < raw.length; i += 2) lines.push(`${raw[i]}: ${raw[i + 1]}`);
  const request = lines.join("\r\n") + "\r\n\r\n";

  // Hand the socket to the relay process so this process's event-loop stalls can't touch the
  // video. If the relay is unavailable (e.g. under Bun, or its script is missing), pipe here.
  const relay = await getRelay();
  if (relay) {
    const message = { type: "pipe", port, request, head: head.toString("base64") };
    const sent = await new Promise<boolean>((resolve) => {
      try {
        relay.send(message, socket, { keepOpen: false }, (error) => resolve(!error));
      } catch {
        resolve(false);
      }
    });
    if (sent) return;
  }
  relaySocket(socket, port, request, head);
}

let relayProcess: Promise<ChildProcess | null> | null = null;

/** Forks the relay once; resolves null if it can't run (callers then pipe in-process). */
function getRelay(): Promise<ChildProcess | null> {
  if (process.env.SERVE_SIM_SIMSTREAM_INPROCESS) return Promise.resolve(null);
  if (relayProcess) return relayProcess;
  const script = join(dirnameOf(import.meta.url), "simstream-relay.js");
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" || !existsSync(script)) {
    return (relayProcess = Promise.resolve(null));
  }
  relayProcess = new Promise((resolve) => {
    const child = fork(script, [], { stdio: ["ignore", "inherit", "inherit", "ipc"], execArgv: [] });
    const timer = setTimeout(() => resolve(null), 5_000);
    child.once("message", () => { clearTimeout(timer); resolve(child); });
    child.once("error", () => { clearTimeout(timer); resolve(null); });
    child.once("exit", () => { clearTimeout(timer); relayProcess = null; resolve(null); });
  });
  return relayProcess;
}

export function stopSimstreamEngines(): void {
  for (const { process } of engines.values()) {
    try { process.kill?.("SIGTERM"); } catch {}
  }
  engines.clear();
}

process.once("exit", stopSimstreamEngines);
