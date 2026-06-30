import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';

import { simMiddleware } from './middleware.js';
import { name as PACKAGE_NAME } from '../package.json';

// TODO: make dynamic to avoid on Expo CLI mounting point
const ENDPOIT_BASE_URL = `/_expo/plugins/${PACKAGE_NAME}`;

const SERVE_SIM_STATE_DIR = path.join(tmpdir(), 'serve-sim');
const SPAWN_RETRY_COOLDOWN_MS = 30_000;

let spawnInFlight = false;
let lastSpawnFailureAt = 0;

const middleware = simMiddleware({ basePath: ENDPOIT_BASE_URL });

export default async function handler(request: Request): Promise<Response | null> {
  // Auto-spawn the helper to ensure at least one running and streaming simulator when user opens the page

  const url = new URL(request.url);
  const isPreviewPageRequest = request.method === 'GET' && (url.pathname === '/' || url.pathname === '');
  if (isPreviewPageRequest) {
    ensureHelperSpawned();
  }
  const response = await middleware(
    // re-add base url to the request to match the middleware's expected URL
    // TODO: can we upstream more dynamic behavior?
    new Request(`${url.origin}${ENDPOIT_BASE_URL}${url.pathname}${url.search}`, request)
  );
  return response ?? null;
}

export const webSocketHandlers = {
  // TODO: update (in Expo CLI) request to be a Request instead of IncomingMessage
  '/exec-ws': (socket: WebSocket, request: IncomingMessage) => {
    const handled = middleware.handleWebSocket?.(request, socket);
    if (!handled) socket.close();
  },
};

function ensureHelperSpawned(): void {
  if (spawnInFlight || helperStateExists()) {
    return;
  }
  if (Date.now() - lastSpawnFailureAt < SPAWN_RETRY_COOLDOWN_MS) {
    return;
  }
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
    if (code !== 0) {
      lastSpawnFailureAt = Date.now();
    }
  });
}

function helperStateExists(): boolean {
  try {
    return readdirSync(SERVE_SIM_STATE_DIR).some(
      (f) => f.startsWith('server-') && f.endsWith('.json')
    );
  } catch {
    return false;
  }
}

function serveSimCliPath(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.join(__dirname, 'serve-sim.js');
}
