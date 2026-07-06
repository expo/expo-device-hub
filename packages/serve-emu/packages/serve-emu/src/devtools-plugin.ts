/**
 * DevTools plugin server entry point for serve-emu (Android emulator preview).
 *
 * This is serve-emu's own DevTools plugin entry — previously the standalone
 * `expo-serve-emu` wrapper package, now folded into serve-emu itself so there is
 * a single package to ship/vendor.
 *
 * Expo CLI calls the default-exported fetch handler for every request to
 * `/_expo/plugins/serve-emu/*` with the plugin prefix stripped from the URL,
 * expecting a fetch `Response` back.
 *
 * serve-emu ships a fetch-style middleware. We mount its multi-device router
 * (`createRouter` → `handleRequest(req) => Response` + `attachWebSocket(socket)`)
 * IN-PROCESS — no spawned Bun child, no HTTP/WS reverse proxy. The router serves
 * the (device-independent) UI shell and `/api/devices` listing without a device,
 * and lazily starts one scrcpy-backed app per `?device=<serial>` (defaulting to
 * the first available device) for `/api/*`, `/health`, and `/ws`. The served
 * `index.html` is rewritten so the UI's root-absolute `/api`, `/ws`, `/health`
 * URLs (with their `?device=` query preserved) resolve under the plugin prefix.
 */

import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { createRouter, fromWsSocket, type WsWebSocketLike } from "./middleware.ts";

// Compiled to ESM (.js), but package.json is JSON loaded with CJS semantics.
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

// One router for the whole CLI process. It owns the per-device scrcpy apps and
// is shared by the HTTP handler and the WebSocket handler below.
const router = createRouter();

// Tie the scrcpy sessions to this process — they mirror live devices, so they
// must not outlive `expo start`.
function stopAll(): void {
  try {
    router.stopAll();
  } catch {}
}
process.once("exit", stopAll);
process.once("SIGINT", stopAll);
process.once("SIGTERM", stopAll);

// ── HTML rewriting ──────────────────────────────────────────────────────────
//
// serve-emu's UI is built to live at the server root: asset tags use absolute
// `/assets/...` paths and the bundle calls `fetch("/api/...")`,
// `new WebSocket(".../ws")`, and `new EventSource("/api/logcat")`. Served under
// the plugin prefix those all miss. Rather than fork the UI, fix it on the way
// out: prefix the asset paths, and inject a classic script (runs before the
// deferred module bundle) that wraps `fetch`/`WebSocket`/`EventSource` to push
// the UI's root-absolute API paths under the plugin prefix. The wrapper keeps
// the query string (so the UI's `?device=<serial>` survives). serve-emu
// standalone is untouched and unaware of any base.
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

// Shown when the document 404s — i.e. the serve-emu UI bundle hasn't been built.
// (Device availability is reflected live in the UI itself, so it is no longer a
// reason to block the page.)
function uiUnavailableResponse(): Response {
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>Emulator</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;margin:3rem auto;max-width:32rem;color:#111}code{background:#eee;padding:.1rem .3rem;border-radius:4px}</style>
</head><body>
<h1>Emulator preview unavailable</h1>
<p>The serve-emu UI has not been built yet. Run <code>bun run setup</code> in the serve-emu package, then reload.</p>
</body></html>`;
  return new Response(page, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
}

export default async function handler(request: Request): Promise<Response> {
  const response = await router.handleRequest(request);

  // Only the HTML document needs the prefix rewrite; assets, JSON, the logcat
  // SSE feed, and screenshots stream straight through.
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const body = rewriteHtml(await response.text());
    const headers = new Headers(response.headers);
    headers.delete("content-length"); // body length changed by the rewrite
    return new Response(body, { status: response.status, headers });
  }

  // A 404 on a navigation means the UI bundle is missing — guide the user.
  if (response.status === 404 && (request.headers.get("accept") || "").includes("text/html")) {
    return uiUnavailableResponse();
  }
  return response;
}

// ── WebSocket handler ───────────────────────────────────────────────────────
//
// serve-emu streams H.264 video and accepts gesture input over a single
// WebSocket at `/ws`. The Expo CLI owns the upgrade and passes the accepted `ws`
// socket to handlers exported here. We resolve the target device from the
// request URL's `?device=<serial>` (defaulting to the first available), ensure
// its app is started, then hand the socket to the router via the `ws`
// StreamSocket adapter — no upstream bridge. `frame-meta=1` selects the
// SEMU-framed packet format. Both query params survive in the un-stripped URL.
async function handleWsConnection(socket: WsWebSocketLike, request: IncomingMessage): Promise<void> {
  const url = new URL(request.url || "/ws", "http://localhost");
  let serial: string;
  try {
    serial = (await router.ensure(url.searchParams.get("device"))).serial;
  } catch {
    try {
      socket.close();
    } catch {}
    return;
  }
  const frameMeta = url.searchParams.get("frame-meta") === "1";
  router.attachWebSocket(fromWsSocket(socket), { serial, frameMeta });
}

export const webSocketHandlers = {
  "/ws": (socket: WsWebSocketLike, request: IncomingMessage) => {
    void handleWsConnection(socket, request);
  },
};
