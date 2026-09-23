# HTTP and WebSocket endpoints reference

serve-sim captures each simulator in-process. The preview server exposes both
the UI routes and device-scoped helper routes; there is no separate Swift HTTP
server. Do not hardcode a port or helper prefix. Discover `url`, `streamUrl`,
and `wsUrl` with:

```sh
npx @expo/serve-sim --list -q
```

For a `streamUrl` ending in `/stream.mjpeg`, its helper base is the URL with
that suffix removed. A standalone server normally uses
`/helper/<udid>`; an embedded middleware may expose a direct helper URL.

## Device helper routes

| Method | Helper-relative path | Returns / accepts |
|---|---|---|
| `GET` | `/stream.mjpeg` | `multipart/x-mixed-replace` MJPEG video. `?raw=1` changes the response type to `application/octet-stream`. |
| `GET` | `/stream.avcc` | Length-prefixed AVCC envelopes for the WebCodecs H.264 client. |
| `GET` | `/ws` | Binary WebSocket carrying tagged JSON input and screen-config updates. |
| `GET` | `/config` | `{width, height, orientation}` for the current display. |
| `GET` | `/health` | `{status: "ok"}`. |
| `GET` | `/ax` | Axe-compatible accessibility JSON. |
| `GET` | `/foreground` | `{bundleId, pid}` for the frontmost app. |
| `POST` | `/webrtc/offer` | JSON WebRTC offer; returns a complete JSON answer after ICE gathering. |
| `POST` | `/webrtc/close` | `{sessionId}`; idempotently releases an active or pending WebRTC session. |

The stream and signaling responses allow cross-origin access. WebRTC media uses
ICE directly; loading the preview through an HTTP tunnel does not tunnel media.
Configure TURN when viewers cannot reach direct or server-reflexive candidates.
WebRTC and HTTP streams can fan out to multiple viewers. WebRTC viewers share
one simulator capture source but use independent peer connections and encoders.

### Input messages

Each client-to-server WebSocket message is `[tag byte][UTF-8 JSON]`, except tag
`0x09`, which has no body.

| Tag | Payload |
|---|---|
| `0x03` | Touch: `{type: "begin"|"move"|"end", x, y, edge?}`. |
| `0x04` | Button: `{button}` or `{button, page, usage, phase}`. |
| `0x05` | Multi-touch: `{type, x1, y1, x2, y2}`. |
| `0x06` | Keyboard: `{type: "down"|"up", usage}`. |
| `0x07` | Orientation: `{orientation}`. |
| `0x08` | CoreAnimation option: `{option, enabled}`. |
| `0x09` | Memory warning; no JSON body. |
| `0x0a` | Digital Crown: `{delta}`. |
| `0x0b` | Scroll: `{dx, dy, x?, y?}`. |
| `0x0c` | Toggle software keyboard; no JSON body required. |

The server-to-client tag `0x82` contains a JSON screen configuration. For
ordinary taps and commands, prefer the CLI over constructing protocol frames.

## Preview middleware routes

`simMiddleware()` defaults to `basePath: "/.sim"`; standalone `serve-sim`
mounts it at `/`. Prefix the paths below with that configured base.

| Method | Path | Returns / accepts |
|---|---|---|
| `GET` | `/` | Preview HTML. |
| `GET` | `/api` | Selected simulator state and browser endpoint configuration. |
| `GET` | `/api/events` | SSE stream of selected-device configuration changes. |
| `POST` | `/api/screenshot` | Still PNG of the selected simulator (`simctl io <udid> screenshot`). |
| `GET` | `/api/event-log` | Recent normalized simulator input events. |
| `GET` | `/api/event-log/events` | SSE event-log updates. |
| `GET` | `/logs` | SSE stream of simulator console logs (NDJSON events). The preview subscribes locally by default; remote previews require `?logs=1`. |
| `GET` | `/ax` | SSE accessibility snapshots. |
| `POST` | `/exec` | Host command execution; requires JSON, same-origin checks, and bearer token. |
| `GET` | `/appstate` | Frontmost-app event stream. |
| `GET` | `/grid/api` | Simulator/device list. |
| `POST` | `/grid/api/start` | Boot and register a simulator. |
| `POST` | `/grid/api/shutdown` | Shut down and unregister a simulator. |
| `GET` | `/grid/api/memory` | Simulator capacity information. |
| `GET` | `/devtools` | WebKit Inspector target list. |

```ts
import { simMiddleware } from "@expo/serve-sim/middleware";

const middleware = simMiddleware({ basePath: "/.sim" });
```

An embedding server must also forward WebSocket upgrades to
`middleware.handleUpgrade`; standalone serve-sim already does this.

## Authentication and state

The `/exec` route requires the per-process bearer token injected into the
same-origin preview. Non-browser callers can obtain it from the private state
file under `$TMPDIR/serve-sim/server-<udid>.json`. Stream, input, accessibility,
and signaling routes are intentionally unauthenticated, so expose serve-sim only
on trusted networks or behind an authenticated proxy.

Prefer `npx @expo/serve-sim --list -q` over reading state files directly. The state
format is internal and may also contain short-lived TURN credentials.
