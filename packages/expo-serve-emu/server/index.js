'use strict';

/**
 * DevTools plugin server entry point for serve-emu (Android emulator preview).
 *
 * Expo CLI calls the default-exported handler for every request to
 * `/_expo/plugins/expo-serve-emu/*` with the plugin prefix stripped from the
 * URL, expecting a fetch `Response` back (or `null` to fall through to static
 * `webpageRoot` serving — this plugin has none, so `null` becomes a 404).
 *
 * Unlike serve-sim — which ships a Node-compatible Connect middleware that can
 * be run in-process — serve-emu is a Bun program (`Bun.serve`, `ServerWebSocket`,
 * `Bun.file`) and cannot be imported into the Node process that runs Expo CLI.
 * So this bridge keeps the vendored serve-emu completely unchanged and instead:
 *
 *   1. Lazily spawns the `serve-emu` CLI as its own Bun process on a free port
 *      (only on the first plugin request — nothing runs until the panel opens).
 *   2. Reverse-proxies HTTP (`handler`) to that process, streaming responses so
 *      serve-emu's SSE route (`/api/logcat`) and binary endpoints work.
 *   3. Proxies the H.264 video WebSocket (`/ws`) via a raw-socket tunnel in the
 *      `handleUpgrade` named export (a patched @expo/cli forwards upgrades here).
 *   4. Rewrites the served `index.html` so the UI's absolute `/api`, `/ws`,
 *      `/health` URLs and its built asset paths resolve under the plugin prefix.
 *
 * Because all the glue lives here, pulling upstream serve-emu changes stays a
 * clean `git am` with no conflicts in the vendored package.
 */

const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');

const { name: PACKAGE_NAME } = require('../package.json');

// Mirrors `DevToolsPluginEndpoint` in @expo/cli. The browser loads this plugin
// under `${DEVTOOLS_PLUGINS_ENDPOINT}/${PACKAGE_NAME}`, so the rewritten UI has
// to emit client URLs against that same base — even though the CLI strips the
// prefix before handing us each request (we re-add it in the rewrite below).
const DEVTOOLS_PLUGINS_ENDPOINT = '/_expo/plugins';
const BASE = `${DEVTOOLS_PLUGINS_ENDPOINT}/${PACKAGE_NAME}`;

// Hop-by-hop headers are connection-scoped and meaningless across the proxy /
// fetch `Response` boundary (and some are rejected by `Headers`). Node picks
// chunked encoding itself for the streamed bodies.
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

// serve-emu's UI roots — the absolute paths the bundle hard-codes. The injected
// patch below rewrites these (and only these) onto the plugin prefix at runtime.
const API_ROOTS = ['/api', '/ws', '/health'];

const STARTUP_TIMEOUT_MS = 30_000;
const SPAWN_RETRY_COOLDOWN_MS = 5_000;

// ── Lazy serve-emu process ──────────────────────────────────────────────────
let serverPort = null;
let childRef = null;
let readyPromise = null;
let lastSpawnFailureAt = 0;

function serveEmuCliPath() {
  // serve-emu's bin is `src/cli.ts` (a Bun shebang script). Its package.json has
  // no `exports` map, so resolve the manifest and join the bin path off it.
  const pkgPath = require.resolve('serve-emu/package.json');
  return path.join(path.dirname(pkgPath), 'src', 'cli.ts');
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Spawn the serve-emu Bun process once and resolve when its port accepts
// connections (serve-emu only starts listening after scrcpy is ready, so the
// first plugin request waits out the emulator/scrcpy handshake). Subsequent
// requests reuse the cached `readyPromise`; if the process dies the next
// request respawns it.
function ensureServerReady() {
  if (readyPromise) {
    return readyPromise;
  }
  if (Date.now() - lastSpawnFailureAt < SPAWN_RETRY_COOLDOWN_MS) {
    return Promise.reject(new Error('serve-emu start is cooling down after a failure'));
  }

  readyPromise = (async () => {
    const port = await getFreePort();
    const cliPath = serveEmuCliPath();
    let exitInfo = null;
    const child = spawn('bun', [cliPath, '--port', String(port)], {
      stdio: 'ignore',
    });
    child.once('exit', (code, signal) => {
      exitInfo = `code ${code ?? 'null'} signal ${signal ?? 'null'}`;
      if (childRef === child) {
        childRef = null;
        serverPort = null;
        readyPromise = null;
      }
    });
    child.once('error', (err) => {
      exitInfo = err.message;
    });
    childRef = child;

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exitInfo != null) {
        throw new Error(`serve-emu exited before it was ready (${exitInfo})`);
      }
      if (await portOpen(port)) {
        serverPort = port;
        return port;
      }
      await delay(300);
    }
    try {
      child.kill();
    } catch {
      // already gone
    }
    throw new Error('serve-emu did not start within the timeout');
  })();

  readyPromise.catch(() => {
    readyPromise = null;
    lastSpawnFailureAt = Date.now();
  });
  return readyPromise;
}

// Tie the serve-emu process lifetime to this one — it streams a live emulator,
// so it should not outlive `expo start`.
function killChild() {
  if (childRef) {
    try {
      childRef.kill();
    } catch {
      // already gone
    }
    childRef = null;
  }
}
process.once('exit', killChild);
process.once('SIGINT', killChild);
process.once('SIGTERM', killChild);

// ── HTML rewriting ──────────────────────────────────────────────────────────
//
// serve-emu's UI is built to live at the server root: its asset tags use
// absolute `/assets/...` paths and the bundle calls `fetch("/api/...")`,
// `new WebSocket(".../ws")`, and `new EventSource("/api/logcat")`. Served under
// `/_expo/plugins/expo-serve-emu/` those all miss. Rather than fork the UI, we
// fix it on the way out: prefix the asset paths in the HTML, and inject a tiny
// classic script (runs before the deferred module bundle) that wraps `fetch`,
// `WebSocket`, and `EventSource` to push the UI's root-absolute API paths under
// the plugin prefix. serve-emu standalone is untouched and unaware of any base.
const INLINE_PATCH = `(function(){
  var BASE=${JSON.stringify(BASE)};
  var ROOTS=${JSON.stringify(API_ROOTS)};
  function needs(p){for(var i=0;i<ROOTS.length;i++){var r=ROOTS[i];if(p===r||p.indexOf(r+"/")===0)return true;}return false;}
  function fix(u){try{var url=new URL(u,location.href);if(url.host===location.host&&needs(url.pathname)&&url.pathname.indexOf(BASE+"/")!==0&&url.pathname!==BASE){url.pathname=BASE+url.pathname;return url.toString();}}catch(e){}return u;}
  var of=window.fetch;
  if(of){window.fetch=function(input,init){if(typeof input==="string")return of.call(this,fix(input),init);if(input&&input.url)return of.call(this,new Request(fix(input.url),input),init);return of.call(this,input,init);};}
  var OW=window.WebSocket;
  if(OW){var W=function(url,protocols){return new OW(fix(url),protocols);};W.prototype=OW.prototype;["CONNECTING","OPEN","CLOSING","CLOSED"].forEach(function(k){W[k]=OW[k];});window.WebSocket=W;}
  var OE=window.EventSource;
  if(OE){var E=function(url,cfg){return new OE(fix(url),cfg);};E.prototype=OE.prototype;window.EventSource=E;}
})();`;

function rewriteHtml(html) {
  return html
    .replace(/<head([^>]*)>/i, `<head$1><script>${INLINE_PATCH}</script>`)
    .replace(/\b(src|href)="\//g, `$1="${BASE}/`);
}

// ── HTTP reverse proxy ───────────────────────────────────────────────────────
function proxyHttp(request, port) {
  return new Promise((resolve) => {
    const url = new URL(request.url);
    const headers = {};
    for (const [key, value] of request.headers) {
      if (HOP_BY_HOP.has(key.toLowerCase()) || key.toLowerCase() === 'accept-encoding') {
        // Drop accept-encoding so serve-emu replies identity and the HTML
        // rewrite stays straightforward.
        continue;
      }
      headers[key] = value;
    }
    headers.host = `127.0.0.1:${port}`;

    const proxyReq = http.request(
      {
        host: '127.0.0.1',
        port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (proxyRes) => {
        const contentType = proxyRes.headers['content-type'] || '';
        const isHtml = contentType.includes('text/html');

        const outHeaders = new Headers();
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (HOP_BY_HOP.has(key.toLowerCase())) {
            continue;
          }
          // Length changes once we rewrite the HTML; let it be recomputed.
          if (isHtml && key.toLowerCase() === 'content-length') {
            continue;
          }
          outHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
        }

        if (isHtml) {
          const chunks = [];
          proxyRes.on('data', (chunk) => chunks.push(chunk));
          proxyRes.on('end', () => {
            const body = rewriteHtml(Buffer.concat(chunks).toString('utf8'));
            resolve(new Response(body, { status: proxyRes.statusCode, headers: outHeaders }));
          });
          proxyRes.on('error', () => {
            resolve(new Response('serve-emu response error', { status: 502 }));
          });
          return;
        }

        // Stream everything else (assets, JSON, the logcat SSE feed, screenshots).
        resolve(
          new Response(Readable.toWeb(proxyRes), {
            status: proxyRes.statusCode,
            headers: outHeaders,
          })
        );
      }
    );

    proxyReq.on('error', () => {
      resolve(new Response('serve-emu is not reachable', { status: 502 }));
    });

    if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
      Readable.fromWeb(request.body).pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  });
}

function unavailableResponse(request) {
  const wantsHtml = (request.headers.get('accept') || '').includes('text/html');
  if (!wantsHtml) {
    return new Response('serve-emu is not available yet', { status: 503 });
  }
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>Emulator</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;margin:3rem auto;max-width:32rem;color:#111}code{background:#eee;padding:.1rem .3rem;border-radius:4px}</style>
</head><body>
<h1>Waiting for an Android emulator</h1>
<p>serve-emu couldn't start. Make sure an emulator or device is booted (<code>adb devices</code>),
that the serve-emu UI has been built (<code>bun run setup</code> in the serve-emu package), then reload.</p>
</body></html>`;
  return new Response(page, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

module.exports = async function handler(request) {
  let port;
  try {
    port = await ensureServerReady();
  } catch {
    return unavailableResponse(request);
  }
  return proxyHttp(request, port);
};

// ── WebSocket upgrade bridge ─────────────────────────────────────────────────
//
// serve-emu streams its H.264 video and accepts gesture input over a single
// WebSocket at `/ws`. The Expo CLI devtools-plugin contract only routes fetch
// requests through the default export; a patched @expo/cli hands matching
// `upgrade` events to this named export (with the full, un-stripped URL).
//
// There is no in-process middleware to delegate to here — serve-emu owns the
// socket in its own Bun process — so we tunnel the raw upgrade through to it:
// open a TCP connection to serve-emu, replay the HTTP upgrade request with the
// plugin prefix stripped from the path, and pipe bytes both ways. Returns true
// to claim the socket (the CLI destroys it if we return false).
module.exports.handleUpgrade = function handleUpgrade(req, socket, head) {
  let pathname;
  let search;
  try {
    const url = new URL(req.url, 'http://localhost');
    pathname = url.pathname;
    search = url.search;
  } catch {
    return false;
  }
  if (!pathname.startsWith(`${BASE}/`)) {
    return false;
  }
  const upstreamPath = pathname.slice(BASE.length) + search;

  // Kick a spawn if nothing is up yet; this socket gets destroyed and the UI
  // reconnects once the HTTP side has the process ready.
  if (!serverPort) {
    ensureServerReady().catch(() => {});
    socket.destroy();
    return true;
  }

  const upstream = net.connect(serverPort, '127.0.0.1', () => {
    let raw = `${req.method} ${upstreamPath} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      const value = req.rawHeaders[i + 1];
      if (key.toLowerCase() === 'host') {
        raw += `Host: 127.0.0.1:${serverPort}\r\n`;
        continue;
      }
      raw += `${key}: ${value}\r\n`;
    }
    raw += '\r\n';
    upstream.write(raw);
    if (head && head.length) {
      upstream.write(head);
    }
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  return true;
};
