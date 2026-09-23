# serve-sim API

Paths are relative to the mount point, which is `/` for a standalone
`serve-sim` and the `basePath` middleware option when embedded.

## Routes

All are `GET` unless marked. `device` takes a simulator udid and defaults to the
server's selected device.

| Path | What it is |
| --- | --- |
| `/healthz`, `/readyz` | Liveness and readiness. The only routes reachable without a token. `/readyz` answers 503 while a device is still starting. |
| `/` | The preview page. |
| `/api` | Current device and stream state, including `execToken`. |
| `/api/screenshot` | `POST`. A still PNG. |
| `/api/events`, `/api/event-log`, `/api/event-log/events` | Device events and the recorded log. |
| `/metrics` | CPU, memory and network samples, one per second. |
| `/logs`, `/ax`, `/appstate` | Device log, accessibility tree, foreground app. |
| `/grid/api`, `/grid/api/catalog`, `/grid/api/status`, `/grid/api/status/events`, `/grid/api/memory` | Grid state, bootable device types, status and host headroom. |
| `/grid/api/start`, `/grid/api/shutdown` | `POST`. Boot or shut a device down. |
| `/grid/api/devicekit-chrome`, `/grid/api/device-placeholder-asset` | Static artwork for the grid UI. |
| `/devtools` | Inspectable WebKit targets, each with a `webSocketDebuggerUrl`. |
| `/devtools/highlight`, `/devtools/release` | `POST`. Highlight a node, release the inspector. |

`/metrics`, `/logs`, `/ax`, `/appstate`, `/api/events` and `/grid/api/status/events`
are server-sent event streams; the rest return JSON.

## Authentication

Without `--require-token` nothing is gated, so the credentials below do not
apply. CORS still does, and a loopback origin is still allowed, which means a
page served from any `localhost` port can read an ungated preview.

With it, the server mints one session token at startup, prints it, and writes it
to the device's state file. Every route is gated as a whole rather than per
route, so a new route is protected by default. `/healthz` and `/readyz` are the
exceptions, because a liveness probe cannot carry a credential.

There are three ways to present the token, and which one you use depends on what
the client is.

**A header, for anything that can set one.**

```
Authorization: Bearer <token>
```

A request that is not a document navigation may also present `?token=`
directly, and is answered rather than redirected.

**The cookie, for a page the server itself served.** A document navigation
carrying `?token=` is answered with a 302 that sets the cookie and drops the
token from the URL, so it does not linger in the address bar or in history. The
cookie is named `serve_sim_access_<suffix>`, where the suffix is the first eight
hex characters of the token's SHA-256, so several previews can share one browser
profile. Over https a framed preview gets `SameSite=None; Secure; Partitioned` instead,
and is accepted only for a same-origin request or a navigation. Plain http falls
back to `Lax`, since the other attributes require `Secure`.

**A WebSocket subprotocol, for a browser.** A browser cannot set a header on a
WebSocket and will not send the cookie cross-origin, so a cross-origin caller
names the token as a subprotocol:

```js
new WebSocket(url, [`serve-sim.token.${token}`]);
```

The handshake names a token subprotocol back, because a client that offered
one fails the connection otherwise. The HID and CDP sockets name the entry that
authenticated; `/exec-ws` is served by `ws`, which names the first one offered.
Offering several is fine; every entry is checked, so a stale token alongside a
fresh one still connects. Values outside the RFC 7230 token charset are dropped
rather than echoed.

The exec channel accepts the same subprotocol at its handshake. It also accepts
the token in its first frame. The preview client falls back to that when its
token has characters a subprotocol cannot carry, such as the `=` padding of
standard base64; older clients and a host that forwards an already accepted
socket use it too.

There is no `?token=` fallback on a WebSocket. Query strings are
recorded by proxy and tunnel access logs; request headers and subprotocols are
not.

The preview page receives the token in its injected config as `execToken`.

## CORS

Every route answers with the configured policy. Pass an origin with
`--cors-origin` (repeatable); loopback origins are always allowed, so local
development needs no flag. A preflight is answered before the gate runs, since
it carries neither cookie nor token.

The policy names the calling origin rather than `*`. `Vary: Origin` is set on
every response under the mount path, including one whose origin is refused, so a
cached copy is never replayed to an origin that would have been allowed.

An origin takes the same shapes `--frame-ancestor` does, so the two flags accept
the same values. That includes one leading wildcard label,
`https://*.expo.dev`, which names deploy previews. The scheme and port still have
to match, and a wildcard covers subdomains only, never the bare host.

Naming an origin here also lets it open the control socket, which runs typed
actions on the host, so it grants more than read access. Loopback is the
exception: it may read the preview without a flag, but it may not open the
control socket unless it is named.

A gated request still answers 401 with the CORS headers attached, so the browser
can read the status rather than reporting an opaque network error.

## Framing

Every gated HTML response carries `Content-Security-Policy: frame-ancestors`,
naming `'self'` plus any origins passed with `--frame-ancestor`. That covers the
proxied DevTools frontend as well as the preview page, since both sit behind the
same cookie.

A value may be a plain origin, `https://expo.dev`, or carry one leading wildcard
label, `https://*.expo.dev`, which is useful for naming deploy previews. A bare
`https://*` is refused, as is a wildcard over a single-label host such as
`https://*.com`, and anything that is not an origin. A registry suffix still
passes: `https://*.github.io` and `https://*.co.uk` would hand framing to every
site hosted there, so a wildcard is only as narrow as the host you name. Who may
frame is the caller's decision; the server only refuses shapes that widen the
policy beyond that.

## WebSockets

All of these are gated by the token, but not identically. `/exec-ws` also checks
the `Origin` a browser sends: it accepts the preview's own origin and any origin
named by `--cors-origin`, and closes anything else even with a valid token.
Loopback is not implicit here. The HID and CDP sockets check the token only, so
any origin holding it can drive them; `frame-ancestors` does not constrain a
WebSocket.

| Path | Purpose |
| --- | --- |
| `{helper}/ws` | HID input. Pointer and key events to the device. |
| `/exec-ws` | Scoped simulator actions. Request and response frames. |
| `/devtools/page/{targetId}` | CDP bridge to an inspectable WebKit target. |

`{helper}` is the helper proxy prefix under the mount point. The target ids for
the DevTools bridge come from `GET /devtools`, which returns a
`webSocketDebuggerUrl` per target.

The CDP bridge forwards frames verbatim in both directions. The token
subprotocol is not forwarded upstream, so the credential stops at serve-sim.
