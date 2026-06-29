/**
 * DevTools plugin server entry point.
 *
 * Expo CLI calls the default-exported fetch handler for every request to
 * `/_expo/plugins/expo-serve-sim/*` with the plugin prefix stripped from the
 * URL, expecting a fetch `Response` back (or `null` to fall through to static
 * `webpageRoot` serving — this plugin has none, so `null` becomes a 404).
 *
 * serve-sim ships a fetch-style middleware — `(request: Request) => Response` —
 * so this file is a thin adapter: it re-adds the stripped plugin prefix to the
 * request URL (so simMiddleware's route matching and the client-facing URLs it
 * emits both line up with the path the browser loads the plugin under) and
 * forwards the request straight through. The SSE routes (`/logs`, `/ax`,
 * `/appstate`, `/api/events`) stream because the middleware returns streaming
 * `Response` bodies that Expo CLI pipes back to the client unchanged.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file ships as ESM (compiled to .mjs), but it loads CommonJS artifacts:
// the vendored serve-sim bundle and our own package.json. `createRequire`
// keeps CJS resolution semantics (and avoids JSON import-attribute friction).
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// serve-sim is vendored under ../vendor/serve-sim at build time (see
// ../build.ts), so we require the bundled copy rather than the npm package.
const { simMiddleware } = require('../vendor/serve-sim/dist/middleware.cjs');
const { name: PACKAGE_NAME } = require('../package.json');

/** A WebSocket connection — only the close path is used directly here. */
interface CloseableSocket {
  close(): void;
}

/** The serve-sim fetch middleware plus its optional WebSocket upgrade hook. */
interface SimMiddleware {
  (request: Request): Promise<Response | null | undefined>;
  handleWebSocket?: (request: IncomingMessage, socket: CloseableSocket) => boolean | undefined;
}

// Mirrors `DevToolsPluginEndpoint` in @expo/cli. The browser loads this plugin
// under `${DEVTOOLS_PLUGINS_ENDPOINT}/${PACKAGE_NAME}`, so simMiddleware has to
// match routes and emit client URLs against that same base — even though the
// CLI strips the prefix before handing us the request (we re-add it below).
const DEVTOOLS_PLUGINS_ENDPOINT = '/_expo/plugins';
const BASE = `${DEVTOOLS_PLUGINS_ENDPOINT}/${PACKAGE_NAME}`;

const middleware: SimMiddleware = simMiddleware({ basePath: BASE });

// ── Lazy helper spawn ─────────────────────────────────────────────────────
//
// simMiddleware only *reads* helper state files — the process that serves the
// actual MJPEG stream + touch WebSocket is the serve-sim helper daemon, which
// plain serve-sim spawns from its CLI (`serve-sim --detach`). Inside Expo CLI
// nothing spawns it, so trigger it here on demand: whenever a plugin request
// arrives and no helper state exists, run `--detach` with no device argument
// (it targets the booted simulator, boots a default one otherwise, and no-ops
// if a helper is already up). Nothing runs until the plugin is first opened.

// Mirrors STATE_DIR in serve-sim — where helper daemons drop server-*.json.
const SERVE_SIM_STATE_DIR = path.join(tmpdir(), 'serve-sim');
const SPAWN_RETRY_COOLDOWN_MS = 30_000;
let spawnInFlight = false;
let lastSpawnFailureAt = 0;

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
  // The vendored CLI bundle lives in the unpacked serve-sim package.
  return path.join(__dirname, '..', 'vendor', 'serve-sim', 'dist', 'serve-sim.js');
}

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
    // Fire-and-forget: the CLI daemonizes the helper and exits. The preview
    // page picks the new state up by itself (the middleware's /appstate SSE
    // watches the state dir), so requests are never blocked on a sim boot.
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

/** Re-add the plugin prefix the CLI stripped, keeping method/headers/body/signal. */
function withPluginPrefix(request: Request): Request {
  const url = new URL(request.url);
  return new Request(`${url.origin}${BASE}${url.pathname}${url.search}`, request);
}

/**
 * True for the request that loads the preview HTML page itself (`GET {base}`),
 * as opposed to the data/control routes (`/api`, `/grid/api`, `/exec-ws`, …).
 * The CLI strips the plugin prefix before calling us, so the preview page
 * arrives with pathname `/` (or empty).
 */
function isPreviewPageRequest(request: Request): boolean {
  if (request.method !== 'GET') return false;
  const { pathname } = new URL(request.url);
  return pathname === '/' || pathname === '';
}

export default async function handler(request: Request): Promise<Response | null> {
  // Only auto-spawn a helper when a human opens the serve-sim preview page
  // itself — never for the data/control routes. This keeps the standalone
  // preview's open-and-it-just-works behavior while letting headless consumers
  // (e.g. the Expo Hub dashboard) read state and drive the grid without
  // silently booting a simulator; they start sims explicitly via the grid's
  // POST /grid/api/start route.
  if (isPreviewPageRequest(request)) {
    ensureHelperSpawned();
  }
  const response = await middleware(withPluginPrefix(request));
  // `null`/`undefined` tells Expo CLI the route wasn't ours, so it falls
  // through to static webpageRoot serving (this plugin has none → 404).
  return response ?? null;
}

// ── WebSocket handlers ─────────────────────────────────────────────────────
//
// serve-sim's control channel (`<BASE>/exec-ws`) carries exec, simulator
// settings, and the SSE side-channels over a single WebSocket — and the client
// is WS-only with no HTTP fallback. The Expo CLI devtools-plugin contract only
// routes fetch requests through the default export above; it never forwards
// `upgrade` events. A patched @expo/cli reads this `webSocketHandlers` map,
// stands up a `ws` server per route mounted at `/_expo/plugins/<name>/<route>`,
// and invokes the handler with the accepted socket on each connection.
//
// `request` is the raw Node IncomingMessage from the upgrade (the patched CLI
// stands the route up as a `ws` server in `noServer` mode and forwards the
// `connection` event's `(socket, request)`). Its URL is the full, un-stripped
// path — already lined up with the `${BASE}/exec-ws` path simMiddleware matches
// on — and serve-sim's `handleWebSocket(req, socket)` reads the URL plus the
// host/origin headers straight off the IncomingMessage (its same-origin guard
// needs `req.headers.origin`/`host` as Node properties), so we forward the
// IncomingMessage through unchanged rather than synthesizing a fetch `Request`.

export const webSocketHandlers = {
  '/exec-ws': (socket: CloseableSocket, request: IncomingMessage) => {
    const handled = middleware.handleWebSocket?.(request, socket);
    if (!handled) socket.close();
  },
};
