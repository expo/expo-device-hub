import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-ignore vendored module, absent until `bun run build:vendor`
import { simMiddleware } from '../../vendor/serve-sim/dist/middleware.js';

const PLUGIN_MOUNT = '/_expo/plugins/expo-device-hub';
export const SIM_PREFIX = '/vendor/serve-sim';
// Must be the full mount path: serve-sim bakes basePath into the client-facing URLs it returns
// (grid / exec-ws / stream), so a shorter value silently breaks the iOS client.
const SIM_BASE_PATH = `${PLUGIN_MOUNT}${SIM_PREFIX}`;

const middleware = simMiddleware({ basePath: SIM_BASE_PATH });

const SERVE_SIM_STATE_DIR = join(tmpdir(), 'serve-sim');
const SPAWN_RETRY_COOLDOWN_MS = 30_000;

let spawnInFlight = false;
let lastSpawnFailureAt = 0;

export async function handleSimRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const isPreviewRoot =
    request.method === 'GET' && (url.pathname === SIM_PREFIX || url.pathname === `${SIM_PREFIX}/`);
  if (isPreviewRoot) ensureHelperSpawned();

  const response = await middleware(
    new Request(`${url.origin}${PLUGIN_MOUNT}${url.pathname}${url.search}`, request),
  );
  return response ?? null;
}

// serve-sim's video (/stream.mjpeg) and touch sockets are served by its detached helper
// directly, not through this mount — /exec-ws is the only same-origin WebSocket.
export const simExecWebSocketHandler = (socket: { close(): void }, request: Request): void => {
  const url = new URL(request.url);
  const rewritten = new Request(
    `${url.origin}${PLUGIN_MOUNT}${url.pathname}${url.search}`,
    request,
  );
  const handled = middleware.handleWebSocket?.(rewritten, socket);
  if (!handled) socket.close();
};

function ensureHelperSpawned(): void {
  if (spawnInFlight || helperStateExists()) return;
  if (Date.now() - lastSpawnFailureAt < SPAWN_RETRY_COOLDOWN_MS) return;
  spawnInFlight = true;
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [serveSimCliPath(), '--detach', '--quiet'], {
      stdio: 'ignore',
      detached: true,
    });
  } catch {
    spawnInFlight = false;
    lastSpawnFailureAt = Date.now();
    return;
  }
  child.unref();
  child.on('error', () => {
    spawnInFlight = false;
    lastSpawnFailureAt = Date.now();
  });
  child.on('exit', (code) => {
    spawnInFlight = false;
    if (code !== 0) lastSpawnFailureAt = Date.now();
  });
}

function helperStateExists(): boolean {
  try {
    return readdirSync(SERVE_SIM_STATE_DIR).some(
      (file) => file.startsWith('server-') && file.endsWith('.json'),
    );
  } catch {
    return false;
  }
}

function serveSimCliPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../vendor/serve-sim/dist/serve-sim.js');
}
