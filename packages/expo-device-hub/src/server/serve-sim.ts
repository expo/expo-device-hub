import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-ignore vendored module, absent until `bun run build:vendor`
import { simMiddleware } from '../../vendor/serve-sim/dist/middleware.js';

import { upgradeHeadersForMiddleware } from './access-token';
import { MOUNT_PATH } from './mount';
import {
  readStandaloneServeSimOptions,
  SERVE_SIM_OPTIONS_ENV,
} from './serve-sim-options';

export const SIM_PREFIX = '/vendor/serve-sim';
// Must be the full mount path: serve-sim bakes basePath into the client-facing URLs it returns
// (grid / exec-ws / stream), so a shorter value silently breaks the iOS client.
const SIM_BASE_PATH = `${MOUNT_PATH}${SIM_PREFIX}`;

const standaloneOptions = readStandaloneServeSimOptions(process.env[SERVE_SIM_OPTIONS_ENV]);
const middleware = simMiddleware({
  basePath: SIM_BASE_PATH,
  proxyHelpers: true,
  ...standaloneOptions,
});

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
    new Request(`${url.origin}${MOUNT_PATH}${url.pathname}${url.search}`, request),
  );
  return response ?? null;
}

// Same-origin WebSockets: the exec/control channel (/exec-ws) and the HID input
// socket (/helper/ws?device=<udid>). Expo CLI accepts the upgrade for each
// registered route and hands us the socket; simMiddleware dispatches by path.
//
// With `--require-token` the middleware gates the upgrade on a bearer or a
// same-origin cookie, and a browser can send neither on a WebSocket. The
// client names the token as the `serve-sim.token.<token>` subprotocol instead
// (expo/serve-sim#173); it is copied into the bearer header here so the
// middleware checks it. The middleware, not this bridge, decides if it is right.
// The exec handler also refuses a cross-origin `Origin`; one the operator
// allowed (`--metrics-cors-origin`, serve-sim's `corsOrigins`) is admitted here.
const allowedUpgradeOrigins = standaloneOptions.metricsCorsOrigins ?? [];
export const simWebSocketHandler = (socket: { close(): void }, request: Request): void => {
  const url = new URL(request.url);
  const rewrittenUrl = `${url.origin}${MOUNT_PATH}${url.pathname}${url.search}`;
  const rewritten = new Request(rewrittenUrl, {
    method: request.method,
    headers: upgradeHeadersForMiddleware(request.headers, rewrittenUrl, allowedUpgradeOrigins),
  });
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
