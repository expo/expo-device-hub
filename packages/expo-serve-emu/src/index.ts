/**
 * DevTools plugin server entry point for serve-emu (Android emulator preview).
 *
 * Expo CLI calls the default-exported fetch handler for every request to
 * `/_expo/plugins/expo-serve-emu/*` with the plugin prefix stripped from the
 * URL, expecting a fetch `Response` back.
 *
 * serve-emu ships a fetch-style middleware (`createApp` → `handleRequest(req) =>
 * Response` + `attachWebSocket(socket)`), so this runs serve-emu IN-PROCESS —
 * no spawned Bun child, no HTTP/WS reverse proxy. It lazily starts one
 * scrcpy-backed app for the booted device on first use, forwards HTTP straight
 * through, and hands the DevTools-plugin WebSocket to `attachWebSocket` via the
 * `ws` adapter. The served `index.html` is rewritten so the UI's root-absolute
 * `/api`, `/ws`, `/health` URLs and asset paths resolve under the plugin prefix.
 */

import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import {
  createApp,
  fromWsSocket,
  pickDevice,
  type EmuApp,
  type WsWebSocketLike,
} from "serve-emu/middleware";

// Compiled to ESM (.mjs), but package.json is JSON loaded with CJS semantics.
const require = createRequire(import.meta.url);
const { name: PACKAGE_NAME } = require("../package.json") as { name: string };

// Mirrors `DevToolsPluginEndpoint` in @expo/cli. The browser loads this plugin
// under `${DEVTOOLS_PLUGINS_ENDPOINT}/${PACKAGE_NAME}`, so the rewritten UI must
// emit client URLs against that base — even though the CLI strips the prefix
// before handing us each request.
const DEVTOOLS_PLUGINS_ENDPOINT = "/_expo/plugins";
const BASE = `${DEVTOOLS_PLUGINS_ENDPOINT}/${PACKAGE_NAME}`;

// serve-emu's UI roots — the root-absolute paths the bundle hard-codes.
const API_ROOTS = ["/api", "/ws", "/health"];

const SPAWN_RETRY_COOLDOWN_MS = 5_000;

// ── Lazy in-process serve-emu app ───────────────────────────────────────────
let app: EmuApp | null = null;
let appPromise: Promise<EmuApp> | null = null;
let lastFailureAt = 0;

// Start (once) the scrcpy-backed app for the booted device. `pickDevice()`
// throws if zero or multiple devices are attached (matching the standalone CLI),
// which surfaces as the "waiting for an emulator" page. A dead session (scrcpy
// exited) is torn down so the next request re-initializes.
function ensureApp(): Promise<EmuApp> {
  if (app) {
    if (app.isStreaming()) return Promise.resolve(app);
    try {
      app.stop();
    } catch {}
    app = null;
    appPromise = null;
  }
  if (appPromise) return appPromise;
  if (Date.now() - lastFailureAt < SPAWN_RETRY_COOLDOWN_MS) {
    return Promise.reject(new Error("serve-emu start is cooling down after a failure"));
  }
  appPromise = (async () => {
    const created = await createApp({ serial: pickDevice() });
    app = created;
    return created;
  })();
  appPromise.catch(() => {
    appPromise = null;
    lastFailureAt = Date.now();
  });
  return appPromise;
}

// Tie the scrcpy session to this process — it mirrors a live device, so it must
// not outlive `expo start`.
function stopApp(): void {
  try {
    app?.stop();
  } catch {}
  app = null;
  appPromise = null;
}
process.once("exit", stopApp);
process.once("SIGINT", stopApp);
process.once("SIGTERM", stopApp);

// ── HTML rewriting ──────────────────────────────────────────────────────────
//
// serve-emu's UI is built to live at the server root: asset tags use absolute
// `/assets/...` paths and the bundle calls `fetch("/api/...")`,
// `new WebSocket(".../ws")`, and `new EventSource("/api/logcat")`. Served under
// the plugin prefix those all miss. Rather than fork the UI, fix it on the way
// out: prefix the asset paths, and inject a classic script (runs before the
// deferred module bundle) that wraps `fetch`/`WebSocket`/`EventSource` to push
// the UI's root-absolute API paths under the plugin prefix. serve-emu standalone
// is untouched and unaware of any base.
// FIXME: This is super hacky, let's update the UI.
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

function rewriteHtml(html: string): string {
  return html
    .replace(/<head([^>]*)>/i, `<head$1><script>${INLINE_PATCH}</script>`)
    .replace(/\b(src|href)="\//g, `$1="${BASE}/`);
}

function unavailableResponse(request: Request): Response {
  const wantsHtml = (request.headers.get("accept") || "").includes("text/html");
  if (!wantsHtml) {
    return new Response("serve-emu is not available yet", { status: 503 });
  }
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>Emulator</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;margin:3rem auto;max-width:32rem;color:#111}code{background:#eee;padding:.1rem .3rem;border-radius:4px}</style>
</head><body>
<h1>Waiting for an Android emulator</h1>
<p>serve-emu couldn't start. Make sure a single emulator or device is booted (<code>adb devices</code>),
that the serve-emu UI has been built (<code>bun run setup</code> in the serve-emu package), then reload.</p>
</body></html>`;
  return new Response(page, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
}

export default async function handler(request: Request): Promise<Response> {
  let current: EmuApp;
  try {
    current = await ensureApp();
  } catch {
    return unavailableResponse(request);
  }

  const response = await current.handleRequest(request);

  // Only the HTML document needs the prefix rewrite; assets, JSON, the logcat
  // SSE feed, and screenshots stream straight through.
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const body = rewriteHtml(await response.text());
    const headers = new Headers(response.headers);
    headers.delete("content-length"); // body length changed by the rewrite
    return new Response(body, { status: response.status, headers });
  }
  return response;
}

// ── WebSocket handler ───────────────────────────────────────────────────────
//
// serve-emu streams H.264 video and accepts gesture input over a single
// WebSocket at `/ws`. The Expo CLI owns the upgrade and passes the accepted `ws`
// socket to handlers exported here; we hand it to the in-process app via the
// `ws` StreamSocket adapter — no upstream bridge. `frame-meta=1` (preserved in
// the un-stripped request URL) selects the SEMU-framed packet format.
async function handleWsConnection(socket: WsWebSocketLike, request: IncomingMessage): Promise<void> {
  let current: EmuApp;
  try {
    current = await ensureApp();
  } catch {
    try {
      socket.close();
    } catch {}
    return;
  }
  const frameMeta =
    new URL(request.url || "/ws", "http://localhost").searchParams.get("frame-meta") === "1";
  current.attachWebSocket(fromWsSocket(socket), { frameMeta });
}

export const webSocketHandlers = {
  "/ws": (socket: WsWebSocketLike, request: IncomingMessage) => {
    void handleWsConnection(socket, request);
  },
};
