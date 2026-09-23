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
| `GET` | `/logs` | Simulator console log (NDJSON). SSE by default, replaying the buffered backlog before live lines; JSON on `Accept: application/json` or `?snapshot`. Requires the bearer token. The preview's Logs drawer polls the JSON form; the browser console dump is opt in with `?logs=1` on the preview URL. |
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

### Reading `/logs`

One shared tail per device fills a byte-bounded buffer, so a reader sees recent
history rather than only what happens next.

| Param | Effect |
|---|---|
| `?snapshot` | Return JSON instead of SSE. `?snapshot=0` keeps SSE even when the request accepts JSON. |
| `?since=<seq>` | Only lines after that cursor. Compare against `oldestSeq` to detect a gap. |
| `?limit=<n>` | At most `n` lines, keeping the newest. |
| `?envelope` | Wrap each SSE frame as `{seq, at, raw}` so a stream reader can track its cursor. Default frames are the bare line, which is already JSON. |
| `?follow` | Start the device tail if it is not already running, and keep it running between polls. Without it a snapshot reads whatever is buffered and reports `status: "stopped"` when nothing is. |

The JSON body carries `lines`, `latestSeq`, `oldestSeq`, `bufferedBytes`,
`status` (`streaming` / `restarting` / `stopped`), and `streamError`.

## Authentication and state

Started with `--require-token`, which is how EAS runs it on the network,
serve-sim gates every route except `/healthz` and `/readyz`. The preview link
carries `?token=`, which the first page load trades for a cookie; API and SSE
callers send `Authorization: Bearer <token>` instead, and WebSocket upgrades
take the bearer or the cookie but never a query token. An authenticated caller
can read the token back as `execToken` from `GET {base}/api`.

Without that flag a loopback server is ungated, on the grounds that it is
already reachable by whoever is on the machine. Expose serve-sim on a network
only with the flag, or behind an authenticated proxy.

