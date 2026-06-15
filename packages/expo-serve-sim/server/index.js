'use strict';

/**
 * DevTools plugin server entry point.
 *
 * Expo CLI calls this default-exported handler for every request to
 * `/_expo/plugins/expo-serve-sim/*` with the plugin prefix stripped from the
 * URL, expecting a fetch `Response` back (or `null` to fall through to static
 * `webpageRoot` serving — this plugin has none, so `null` becomes a 404).
 *
 * serve-sim ships a Connect-style middleware `(req, res, next)` rather than a
 * fetch handler, so this file bridges the two: it fakes a Node
 * `IncomingMessage`/`ServerResponse` pair, runs `simMiddleware` against them,
 * and streams whatever the middleware writes back out as a `Response`. The
 * streaming bridge is what keeps serve-sim's SSE routes (`/logs`, `/ax`,
 * `/appstate`, `/api/events`) working through the fetch boundary.
 */

const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { simMiddleware } = require('serve-sim/middleware');
const { name: PACKAGE_NAME } = require('../package.json');

// Mirrors `DevToolsPluginEndpoint` in @expo/cli. The browser loads this plugin
// under `${DEVTOOLS_PLUGINS_ENDPOINT}/${PACKAGE_NAME}`, so simMiddleware has to
// match routes and emit client URLs against that same base — even though the
// CLI strips the prefix before handing us the request (we re-add it below).
const DEVTOOLS_PLUGINS_ENDPOINT = '/_expo/plugins';
const BASE = `${DEVTOOLS_PLUGINS_ENDPOINT}/${PACKAGE_NAME}`;

// Hop-by-hop headers are managed by Node's http layer on the real response;
// carrying them across the fetch `Response` boundary is meaningless (and some
// are rejected by `Headers`). Node will pick chunked encoding for SSE itself.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
]);

const middleware = simMiddleware({ basePath: BASE });

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

function helperStateExists() {
  try {
    return readdirSync(SERVE_SIM_STATE_DIR).some(
      (f) => f.startsWith('server-') && f.endsWith('.json')
    );
  } catch {
    return false;
  }
}

function serveSimCliPath() {
  // serve-sim's exports map doesn't expose package.json or the bin script, so
  // locate the CLI bundle relative to the middleware entry — both live in dist/.
  return path.join(path.dirname(require.resolve('serve-sim/middleware')), 'serve-sim.js');
}

function ensureHelperSpawned() {
  if (spawnInFlight || helperStateExists()) {
    return;
  }
  if (Date.now() - lastSpawnFailureAt < SPAWN_RETRY_COOLDOWN_MS) {
    return;
  }
  spawnInFlight = true;
  let child;
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

function toBytes(chunk) {
  return typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
}

module.exports = function handler(request) {
  ensureHelperSpawned();
  return new Promise((resolve, reject) => {
    const url = new URL(request.url);

    // ── Fake Node IncomingMessage ──────────────────────────────────────────
    const req = new EventEmitter();
    // Re-add the plugin prefix the CLI stripped so route matching and the
    // client-facing URLs simMiddleware generates both line up with the path
    // the browser actually loads the plugin under.
    req.url = `${BASE}${url.pathname}${url.search}`;
    req.method = request.method;
    req.headers = Object.fromEntries(request.headers);
    if (!req.headers.host) {
      req.headers.host = url.host;
    }

    // ── Fake Node ServerResponse backed by a web ReadableStream ────────────
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headersSent = false;
    res.writableEnded = false;
    const outHeaders = {};
    let controller = null;
    let resolved = false;

    function sendHead() {
      if (resolved) {
        return;
      }
      resolved = true;
      res.headersSent = true;
      const headers = new Headers();
      for (const [key, value] of Object.entries(outHeaders)) {
        if (HOP_BY_HOP.has(key.toLowerCase())) {
          continue;
        }
        headers.set(key, String(value));
      }
      // `start` runs synchronously during construction, so `controller` is set
      // before this function returns and any subsequent enqueue is safe.
      const body = new ReadableStream({
        start(c) {
          controller = c;
        },
        // The CLI pipes this body to the real client response; when that client
        // disconnects the pipe is cancelled. Surface it to simMiddleware as a
        // request `close` so it tears down its log/ax child processes.
        cancel() {
          res.writableEnded = true;
          req.emit('aborted');
          req.emit('close');
        },
      });
      resolve(new Response(body, { status: res.statusCode, headers }));
    }

    res.setHeader = (key, value) => {
      outHeaders[key] = value;
      return res;
    };
    res.getHeader = (key) => outHeaders[key];
    res.removeHeader = (key) => {
      delete outHeaders[key];
    };
    res.writeHead = (statusCode, reasonOrHeaders, maybeHeaders) => {
      res.statusCode = statusCode;
      const headers =
        reasonOrHeaders && typeof reasonOrHeaders === 'object' ? reasonOrHeaders : maybeHeaders;
      if (headers) {
        for (const key of Object.keys(headers)) {
          outHeaders[key] = headers[key];
        }
      }
      sendHead();
      return res;
    };
    res.write = (chunk) => {
      sendHead();
      if (chunk != null && controller) {
        controller.enqueue(toBytes(chunk));
      }
      return true;
    };
    res.end = (chunk) => {
      sendHead();
      if (chunk != null && controller) {
        controller.enqueue(toBytes(chunk));
      }
      res.writableEnded = true;
      if (controller) {
        try {
          controller.close();
        } catch {
          // already closed (e.g. client disconnected) — nothing to do
        }
      }
      res.emit('finish');
      res.emit('close');
    };

    function next(err) {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      // simMiddleware didn't claim this route — fall through to the CLI, which
      // 404s since this plugin defines no webpageRoot.
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }

    try {
      middleware(req, res, next);
    } catch (err) {
      reject(err);
      return;
    }

    // Feed the request body to simMiddleware's `data`/`end` listeners (POST
    // routes such as /exec and /grid/api/*). Deferred to a microtask so the
    // route handler — which ran synchronously above — has already attached its
    // listeners before the first chunk is emitted.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      void (async () => {
        try {
          if (request.body) {
            for await (const chunk of Readable.fromWeb(request.body)) {
              req.emit('data', Buffer.from(chunk));
            }
          } else {
            const buf = Buffer.from(await request.arrayBuffer());
            if (buf.length) {
              req.emit('data', buf);
            }
          }
          req.emit('end');
        } catch (err) {
          req.emit('error', err);
        }
      })();
    }
  });
};

// ── WebSocket upgrade bridge ───────────────────────────────────────────────
//
// serve-sim's control channel (`<BASE>/exec-ws`) carries exec, simulator
// settings, and the SSE side-channels over a single WebSocket — and the
// client is WS-only with no HTTP fallback. The Expo CLI devtools-plugin
// contract only routes fetch requests through the default export above; it
// never forwards `upgrade` events. A patched @expo/cli looks for this named
// export and hands matching upgrades here (with the full, un-stripped URL, so
// it lines up with the `${BASE}/exec-ws` path simMiddleware matches on).
//
// Returns true when serve-sim claimed the socket, false when the path wasn't
// ours (the CLI then destroys it). simMiddleware is the booted-state branch's
// middleware; `handleUpgrade` is always present on it.
module.exports.handleUpgrade = function handleUpgrade(req, socket, head) {
  return middleware.handleUpgrade?.(req, socket, head) ?? false;
};
