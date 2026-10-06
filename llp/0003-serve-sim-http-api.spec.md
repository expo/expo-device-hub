# LLP 0003: serve-sim API

**Type:** Spec
**Status:** Active
**Systems:** ServeSim
**Author:** Gabe Debes
**Date:** 2026-09-23
**Revised:** 2026-10-06 (raw HID close-delivery and cleanup contract)
**Related:** LLP 0001, LLP 0002

> File paths such as `src/…` are relative to `packages/serve-sim/packages/serve-sim`, unless the text gives a path from the repository root.

Paths are relative to the mount point, which is `/` for a standalone
`serve-sim` and the `basePath` middleware option when embedded.

## Routes

All are `GET` unless marked. `device` takes a simulator udid and defaults to the
server's selected device.

| Path | What it is |
| --- | --- |
| `/healthz`, `/readyz` | Liveness and readiness. These remain reachable without a token when `--require-token` is set. `/readyz` answers 503 while a device is still starting. |
| `/` | The preview page. |
| `/api` | Current device and stream state, including `execToken`. |
| `/api/screenshot` | `POST`. A still PNG. |
| `/api/apps/icon?bundleId=<id>` | An installed app's icon, `{ok, bundleId, icon: {mimeType, data} \| null}`, the same shape as serve-emu's route, with `bundleId` in place of `packageName`. `icon` is null when the app has its icon only in `Assets.car`. 404 when the app is not installed, 503 when `simctl` cannot answer (retry). |
| `/api/pasteboard` | `POST` reads the simulator pasteboard as `{ok, text}`; `PUT` with `{"text": …}` writes it. See [Pasteboard](#pasteboard). |
| `/helper/<udid>/recording/video` | `GET` reports whether a recording is active; `POST` starts, `PUT` renews, and `DELETE` finalizes a native-size H.264 recording. Mutations require a recording ID; when `--require-token` is set, they also require its bearer token. |
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

## Recording video

Use `serve-sim record-video --udid <udid> --output <empty-dir>` against a
running session. The CLI owns and renews the recording lease;
SIGINT stops it and waits for `recording.mp4` and `session.json`. The server
also attempts to finalize active recordings during shutdown. One recording may
run per device. The manifest retains the record-sim upload schema. See
[Video pipeline and recording](0001-serve-sim-video-pipeline.explainer.md) for frame handling and limits.

To control recording directly, `POST` a JSON body such as
`{"start":true,"output":"/path/to/empty-dir","recordingId":"client-id"}`.
The server accepts the JSON body even with `Content-Type: text/plain`.
Send `x-recording-id: client-id` on `PUT` to renew the lease and on `DELETE`
to finalize; `DELETE` returns the manifest path. `GET` returns
`{"active":true}` while recording is starting, active, or finishing, and
`{"active":false}` otherwise. Use a new empty output directory for each
recording; an existing `recording.mp4` or `session.json` is preserved. A
`DELETE` that arrives before its `POST` cancels that recording ID for two
minutes. Repeating `DELETE` during or after finalization returns the same
result until another recording starts.

## Pasteboard

`POST /api/pasteboard` reads the simulator pasteboard; `PUT /api/pasteboard` with
`{"text": "…"}` writes it. Besides the token, both need a browser `Origin`: the
preview's own origin or one that the CORS policy allows. A request without an
`Origin` gets 403. Text over 4 MiB, in either direction, returns 413. A read
that neither `simctl pbpaste` nor the app reader can answer returns 503 with a
message that says what to do next. The `PUT` body can be up to 8 MiB, to leave
room for JSON escaping. Responses are not cached.
[LLP 0010](0010-serve-sim-clipboard.explainer.md) explains the design.

## Authentication

Without `--require-token`, neither the preview nor recording control requires
a session token. CORS still applies, and a loopback origin is still allowed,
so a page served from any `localhost` port can read an ungated preview.
If the server is reachable over a network in this mode, any reachable client,
including a cross-origin web page using a simple POST, can choose a recording
output directory that the server process can write.
Use `--require-token` when that access should be restricted.

With it, the server mints one session token at startup, prints it, and writes it
to the device's state file. Every route is gated as a whole rather than per
route, so a new route is protected by default. `/healthz` and `/readyz` are the
exceptions, because a liveness probe cannot carry a credential.

Recording control requires the bearer token when the preview is gated; its
cookie and query-token forms do not authorize `POST`, `PUT`, or `DELETE`.

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

An embedder can pass its own `execToken` to `simMiddleware`. It must not be
empty, because the exec channel would then accept an empty `token` frame from
any client. Under `requirePreviewToken` it may use only letters, digits, and
`-._~`: these travel unchanged as a bearer, a query, a cookie, and a
subprotocol. `simMiddleware` throws on any other token.

## Allowed hosts

Without `--require-token`, the preview page embeds the session token and `/` is
not gated. A page on another domain that resolves to this machine (DNS
rebinding) is same-origin in the browser, so it could read that token. To stop
it, an ungated preview answers only for `localhost`, `*.localhost`, and IP
addresses; a rebinding page always arrives with its own domain name. Any other
`Host` gets 403 before the page or the token is served, and a WebSocket from
such a host is closed before it can authenticate.

To open an ungated preview on another name (a `.local` name, a tunnel), pass
`--allow-any-host-when-insecure` (`allowAnyHostWhenInsecure` when embedding).
That turns the check off, so a rebinding page could read the token again. Under
`--require-token` the check is off anyway: a rebinding page has no cookie for
the preview and cannot read the token.

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

### Raw HID close contract

The raw HID adapter releases session capacity exactly once, stops its heartbeat,
and discards buffered and subsequent input before ending the transport. It
queues the close frame through `socket.end(...)`, allowing previously queued
output and the close code/reason to flush instead of destroying TCP immediately
[observed: `src/socket/server-input.ts`, `rawHidSocket`].

If TCP has not closed, an unreferenced timer schedules destruction after
1,000 ms; actual TCP close cancels that timer. This is bounded best-effort
cleanup, not a guarantee that the peer receives the frame or that a busy event
loop runs the timer at an exact deadline [observed: `rawHidSocket.shutdown`
and its socket `close` listener]. The close-delivery tests cover immediate
capacity release, idempotent close, discarded input, cleanup of an unresponsive
peer, and receipt of the 1013 refusal code/reason over a real Node socket with
concurrent input [observed: `src/__tests__/raw-hid-socket.test.ts`].
