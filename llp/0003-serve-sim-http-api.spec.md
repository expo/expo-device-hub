# LLP 0003: serve-sim API

**Type:** Spec
**Status:** Active
**Systems:** ServeSim, HubClient
**Author:** Gabe Debes
**Date:** 2026-09-23
**Revised:** 2026-10-15 (rotation readback and app actions; clipboard; server-wide preview sharing; capture reboot status and recording admission; device-state recording manifest; settings and device actions; action catalog)
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
| `/api/pasteboard` | `POST` reads the simulator pasteboard as `{ok, text}`; `?copy=1` presses Command+C first; `PUT` with `{"text": …}` writes it. See [Pasteboard](#pasteboard). |
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
run per device. The manifest retains the required record-sim upload fields and
may include a `deviceStates` timeline. Older manifests without that field remain
valid [observed: `Sources/StreamingPolicy/RecordingManifest.swift`]. See
[device-state metadata](0001-serve-sim-video-pipeline.explainer.md#device-state-metadata)
for the timeline contract, and
[Video pipeline and recording](0001-serve-sim-video-pipeline.explainer.md)
for frame handling and limits.

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

### Recording reboot state

During an intentional capture reboot, `/webrtc/stats` includes `capture.rebooting: true`
until capture resumes from fresh frames. Serve-sim preview watchdogs defer failure classification
while it is true. An absent field on older hosts does not imply a pause. New recording
POSTs receive HTTP 503 `capture_rebooting`; an existing recording still accepts lease
renewal and stop [observed: `Sources/SimNative/CaptureEngine.swift`, `src/device-session.ts`, and
`src/client/hooks/use-webrtc-stream.ts`].


## Pasteboard

`POST /api/pasteboard` reads the simulator pasteboard; `PUT /api/pasteboard` with
`{"text": "…"}` writes it. Besides the token, both need a browser `Origin`: the
preview's own origin or one that the CORS policy allows. A request without an
`Origin` gets 403. Text over 4 MiB, in either direction, returns 413. A read
that neither `simctl pbpaste` nor the app reader can answer returns 503 with a
message that says what to do next. The `PUT` body can be up to 8 MiB, to leave
room for JSON escaping. Responses are not cached.
[LLP 0010](0010-serve-sim-clipboard.explainer.md) explains the design.

When `simctl pbpaste` fails, a read can ask the app reader. Before it asks, it
grants the target app pasteboard access with `simctl privacy`. A read that
fails after the grant also leaves it. serve-sim never undoes the grant. It is
stored in the simulator's privacy (TCC) database. On an iOS 26.4 simulator, it
stayed after a reboot. It also replaced a Deny that `simctl privacy revoke`
stored. While it stayed, the app got no "Allow Paste" prompt.
`xcrun simctl privacy <udid> reset pasteboard <bundle-id>` returns the app to
the prompt. A later read through the app reader grants access again. Do not
use `revoke`. On that simulator, it stored a Deny, and pasteboard reads in the
app then got empty text with no prompt. `--disable clipboard`, or
`clipboard: false` for `simMiddleware`, prevents the grant.
[LLP 0010](0010-serve-sim-clipboard.explainer.md#the-pasteboard-grant-stays)
gives the details.

`POST /api/pasteboard?copy=1` is Copy: the server presses Command+C in the
device's input queue, waits for the pasteboard to change, and returns the copied
text. It returns 504 when the app does not change the pasteboard within 5 s, and
409 when the device has no input session or another process holds the pasteboard
lock for more than one second. A lock conflict says "Simulator clipboard is busy.
Try again." Copy checks and installs `ServeSimPasteboard.app` under that same lock
(`com.expo.serve-sim-pasteboard`) on the simulator when it is missing or
differs from the copy that serve-sim ships. Each Copy grants it pasteboard
access. The app and the grant stay after Copy, and the app shows on the Home
screen. `--disable clipboard`, or `clipboard: false` for `simMiddleware`, does
not prevent this.

## Preview sharing

`--disable-share` (or the middleware's `disableShare: true`) hides only the
preview's Share button. The setting survives device changes and an empty device
state. It does not change authentication or prevent an authorized viewer from
sharing a token manually [observed: `src/index.ts`, `src/middleware.ts`,
`src/client/components/share-session-button.tsx`, `src/client/client.tsx`].

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

With `--require-token`, all of these need the token, but not identically.
`/exec-ws` also checks the `Origin` a browser sends: it accepts the preview's
own origin and any origin named by `--cors-origin`, and closes anything else
even with a valid token. Loopback is not implicit here. The HID and CDP sockets
do not check the `Origin` for a bearer token or a token subprotocol, so any
origin holding the token can drive them. The access cookie passes only on a
same-origin request. `frame-ancestors` does not constrain a WebSocket.

Without `--require-token`, the HID and CDP sockets need neither the token nor an
allowed `Origin`. Only the `Host` check in [Allowed hosts](#allowed-hosts)
applies. `/exec-ws` still checks the `Origin` and needs the token.

| Path | Purpose |
| --- | --- |
| `{helper}/ws` | HID input. Pointer and key events, and Paste, to the device. |
| `/exec-ws` | Scoped simulator actions. Request and response frames. |
| `/devtools/page/{targetId}` | CDP bridge to an inspectable WebKit target. |

`{helper}` is the helper proxy prefix under the mount point. The target ids for
the DevTools bridge come from `GET /devtools`, which returns a
`webSocketDebuggerUrl` per target.

### CLI input admission

Helpers advertise `inputAdmission: true` in their state record and send the
single-byte `0x83` frame after reserving an input slot. The CLI's short input
commands wait for that frame before sending. A full pool closes with `1013`,
which fails the command even if the refusal arrives after the transport opens.
A connection that never admits input fails after ten seconds. Older helpers
without the state flag retain their open-based behavior [observed:
`src/socket/cli-input.ts`, `src/index.ts`, `src/state.ts`].

The CDP bridge forwards frames verbatim in both directions. The token
subprotocol is not forwarded upstream, so the credential stops at serve-sim.

### Software keyboard requests

HID tag `0x0c` toggles the software keyboard; tag `0x0d` requests a boolean
`visible` state. Missing or non-boolean visibility values are ignored. Manual
toggles and visibility requests share one queue in arrival order; adjacent
visibility requests may coalesce. Their handlers stay in flight through the
queued native work, so the existing 1,024-message per-socket admission limit
also counts pending keyboard requests. A device-wide limit of 1,024 pending
viewer keyboard messages includes disconnected viewers and coalesced visibility
requests; overflow closes the requesting socket with `1013` without queueing
another request. Each message releases its slot when its associated queue entry
completes or is discarded, so a later slow operation does not retain completed
messages' admission slots [observed: `attachHidSocket`,
`handleHidMessage`, and `queueSoftwareKeyboardSync` in `src/device-session.ts`].

Accepted manual toggles survive viewer disconnect. Disconnect restores a
keyboard that serve-sim automatically hid; it does not undo a manual toggle
[observed: `detachHidSocket` and `drainSoftwareKeyboardSync` in
`src/device-session.ts`].

### Rotation readback

The helper HID socket accepts a `0x07` frame carrying `{ orientation }`.
Successful native delivery does not mean that the foreground app accepted the
requested interface orientation. For regular devices, config `orientation`
starts from native screen readback, then retains the last successfully delivered
request as device framing. A portrait-only app such as Home therefore does not
turn the frame back. Later native interface-orientation changes, including ones
from Simulator.app, do not replace that framing; another helper rotation request
does, or a new session seeds it again from native readback. This also works with
older native APIs without orientation metadata. Native dimensions, screen routing
and recording metadata still come from capture readback
[observed: `src/device-session.ts` case `0x07` and `readScreenFromNative`, `Sources/SimNative/FrameCapture.swift`].

Foldable devices retain native interface-orientation readback because their
physical framing is controlled separately by the Duo view. That remains true
when hinge capability discovery completes after an early rotation request
[observed: `src/device-session.ts` `readScreenFromNative`, `src/client/client.tsx` `rotateDevice`].

The standalone preview and HubClient advance Rotate from requested poses, so
rapid clicks or an app-declined pose do not repeat the same request. They ignore
mismatched orientation readback for up to 1,500 ms after the latest request;
its acknowledgement releases that protection early. Only orientation changes
update the cursor; HubClient also reconciles a repeated changed readback that it
deferred during the grace period once protection expires. An unchanged,
previously reconciled pose does not reset an app-declined request. HubClient
resets the cursor when the helper or capture session changes. The displayed
screen remains server-owned
[observed: `src/client/simulator/rotation-cursor.ts`, `packages/@expo/hub-client/src/rotation-cursor.ts` and `useIosDevice.ts`].

HubClient advances its cursor only after the browser socket's `send` returns.
Queued Rotate clicks resolve their next pose at delivery, in queue order;
expired or evicted clicks never advance it. Helpers advertising `inputAdmission`
must send `0x83` or a valid `0x82` screen config before HubClient sends input.
A screen config that establishes admission reconciles orientation before queued
clicks flush, while an older initial config cannot overwrite newer sent poses
during the grace period.
Legacy helpers retain send-on-open compatibility. Browser submission does not
prove native delivery or app acceptance
[observed: `packages/@expo/hub-client/src/ws-send-queue.ts`, `rotation-cursor.ts` and `useIosDevice.ts`].

### Printable key characters

The HID key frame (`0x06`) accepts a physical `usage` with `type: "down" | "up"`, plus optional `key` and legacy `shifted` metadata. A single-character keydown can name the browser-layout character. For a non-hinge Simulator with the hardware keyboard off, the helper uses software-keyboard typing when the character is shifted or differs from that physical US key. Matching unshifted US keys, shortcuts without character metadata, and key releases retain HID handling. After hardware-keyboard-off setup, software-character input waits for the guest keyboard to become visible within a three-second window. That check does not press a key; the character attempt runs once, and disconnect or generation change cancels it. A slow native visibility read releases the input turn by the deadline (or within a 25 ms ownership check after disconnect). Readiness uses a read-only native keyboard scan, stopping after two known keyboard identifiers with a 250 ms total traversal/XPC budget; it does not serialize the full UI tree. Only one readiness read can remain in flight, and a new hardware-keyboard setup cannot reuse an earlier setup's result. Characters use HID fallback if the window expires while a read remains pending; its late result cannot type a character. Matching US HID keys skip this wait. A software-typed key suppresses its matching physical release; unavailable software characters and other device modes keep the existing HID fallback [observed: `src/device-session.ts`, key frame routing; `src/text-to-keys.ts`, `US_KEYBOARD_MAP`].

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

### Launching an installed app

An authenticated `/exec-ws` client can launch an installed app with
`{id, action: "app.launch", params: {udid, bundleId, launchArgs?, openUrl?}}`.
Use a Simulator UDID. The action restarts the app with the supplied arguments,
preserves the session's active capabilities, then pre-approves and opens the
optional deep link. Pre-approval is best effort. Launch arguments are limited
to 256 arguments of 8,192 characters each and 128 KiB total UTF-8 bytes,
including terminators. The action replies with
`{id, stdout, stderr, exitCode}`; invalid parameters and unsupported actions
reply with `{id, error}`. Installation stays a separate operation. Setup finishes
before the app stops. If the stop or the launch fails, the action restores the
previous app target, launch settings, and capability environment. The deep link
opens after the app is running, so a failed `openUrl` keeps the new launch.

### App controls

- `app.stop`: `{udid, bundleId}`. Terminates the app; returns an error if it
  cannot be terminated, including when it is already stopped.
- `app.openUrl`: `{udid, bundleId, url}`. Opens a deep link with best-effort
  custom-scheme pre-approval, without first restarting the app. To launch and open
  a link together, use `app.launch` with `openUrl`. URLs are limited to 8,192
  characters and cannot contain NUL.

Both actions require a specific Simulator UDID and use the authenticated
`/exec-ws` channel.

### App data files

- `app.container`: `{udid, bundleId, type?: "app" | "data"}`. Returns the
  container path. The default remains `"app"`; select `"data"` for writable app storage.
- `app.file.list`: `{udid, bundleId, relativePath?}`. Returns a JSON array of
  entry names and types. Omit the path for the container root. Limited to 1000 entries.
- `app.file.read`: `{udid, bundleId, relativePath}`. Returns file bytes as base64,
  limited to 10 MiB per regular file.
- `app.file.remove`: `{udid, bundleId, relativePath}`. Deletes one regular file,
  never a directory.

These API actions use the authenticated `/exec-ws` channel and require a specific
Simulator UDID. Paths are relative to the selected app's **data** container;
traversal and symlinks encountered during path checks, including in the container
root or its ancestors, are refused. Keep the app
stopped and prevent other tools from changing its directories during an operation.
Requests are serialized with app controls on the same device; another device can
proceed independently. The preview UI has no storage editor. These actions are
currently iOS Simulator only; serve-emu does not expose equivalent file actions.
Android parity remains outside this serve-sim rollout.

### Uploading an app fixture

`app.file.upload`: `{udid, bundleId, uploadId, relativePath, overwrite?}` copies a
completed staged upload into the app's data container, creating parent directories.
It returns JSON with `relativePath` and the copied byte count. Writes are atomic
and refuse existing files unless `overwrite: true`. Files are limited to 10 MiB;
staged uploads remain available until `upload.remove` or staging cleanup.
Within a server, staging resets, pruning and removals wait while a copy reads its
source bytes. Each server process stages uploads in its own folder, so an upload ID
names only uploads sent to that server. Send `upload.append` and `app.file.upload`
to the same server. The staging size limit counts the folders of all servers; two
servers that upload at the same time can each pass it by one chunk. Each
upload chunk removes the folders of servers that exited, and uploads older than six
hours in any folder. A copy that already opened its source still reads all of it.

Send requests sequentially: `app.stop` → `upload.append` → `app.file.upload` →
`app.launch`, then `upload.remove` when the staged source is no longer needed.
Finish all chunks before copying, and keep the app stopped until all related
files are in place. Atomicity applies to each file, not a multi-file transaction.

For example, seed `Documents/session.json` or an app-compatible SQLite database.
The app must understand the format. For SQLite, stop the app and use a consistent
checkpointed snapshot, or restore the matching database and WAL files together.
These actions copy bytes; they do not translate JSON into AsyncStorage, import
Keychain entries, create backend sessions, or execute uploaded JavaScript.

### Action coverage

Every serve-sim command or capability that makes sense for users to interact with
must also be available as a host action on `/exec-ws`. Add or update the action
alongside the command or capability so action clients can use the same controls
[confirmed: Gabe Debes, 2026-10-15].

### Input actions

- `tap`: `{udid, x, y}`, with normalized coordinates from 0 to 1.
- `gesture`: `{udid, events}`, a complete sequence of 2–256 touch events. Each
  event has `type`, normalized `x` and `y`, optional `edge` (0–4), and optional
  `delayMs` (0–1000) before that event. Start with `begin`, finish with `end`, and
  use only `move` between them. Omitted delays default to 40 ms before every event
  after the first; explicit zero is allowed. Total delay, including defaults, is
  limited to 30 seconds.
- `type`: `{udid, text}`, up to 4096 US-keyboard ASCII characters, including
  newline and tab. Leading dashes are passed literally; CRLF and lone carriage
  returns are normalized to a single newline before typing.

These actions use the existing CLI input paths. `serve-sim gesture` accepts the
event array as its JSON argument and keeps one admitted connection for the whole
sequence, then waits for the input-completion barrier before reporting success.
The legacy single-event JSON argument remains supported; separate single-event
calls cannot form a drag because disconnect releases that connection's touch.
Tap and typing also wait for an input-completion barrier; a disconnect or failed
barrier reports failure instead of success for input still waiting in the queue.

### Simulator settings and device actions

Each simulator setting in the sidebar has a read action and a write action on
`/exec-ws`: `<setting>.get` with `{udid}` and `<setting>.set` with `{udid, value}`,
for `hardwareKeyboard`, `reduceMotion`, `increaseContrast`, `reduceTransparency`,
`voiceover`, `liquidGlass`, `colorFilter`, `textSize` and `showBorders`. Values are
the canonical values of `serve-sim ui` (`UI_OPTIONS` in `src/ui-settings.ts`),
plus `increment` and `decrement` for `textSize`; aliases are refused. `settings.status` returns every setting as JSON.

- `softwareKeyboard.toggle`: `{udid}`. Shows or hides the on-screen keyboard, like ⌘K.
- `memoryWarning`: `{udid}`. Sends a memory warning to the device.
- `caDebug.set`: `{udid, option, value}`. `option` is a name from `src/ca-debug.ts`;
  `value` is `on` or `off`.
- `hinge.get`: `{udid}`. Reads the hinge state as JSON.
- `hinge.set`: `{udid, value}`. `value` is `fold`, `half`, `unfold` or an angle from
  0 to 180.
- `permissions.list`: `{udid, bundleId?}`. Returns the app permissions as JSON.

Each action runs the matching `serve-sim` CLI command as a child process and replies
with `{id, stdout, stderr, exitCode}`. `softwareKeyboard.toggle`, `memoryWarning`
and `caDebug.set` send an input message and do not wait for the device to confirm it.

`serve-sim software-keyboard -d <device>` accepts a UDID or simulator name and
requires an existing serve-sim server. After a literal state lookup, it matches
names case-insensitively across runtimes and selects the unique live stream.
Multiple live matches fail before connecting and list their UDIDs for explicit
selection with `--device`. The selected record's WebSocket URL, token and
admission flag stay unchanged, including for legacy helpers [observed:
`resolveDeviceMatches` in `src/device.ts`, `readDeviceState` and
`softwareKeyboard` in `src/index.ts`].

The CLI tap, gesture, button, rotate, CA debug and memory-warning senders reuse
this live-name selection and input admission path [observed: `sendHelperMessage`
and its callers in `src/index.ts`].

### Clipboard actions

`clipboard.read` and `clipboard.copy` take `{udid}` and return JSON in `stdout`
as `{text, cleanupWarning?}`. Read returns the existing pasteboard; Copy sends
Command+C to the current selection and waits for new text. `clipboard.write`
takes `{udid, text}` without pasting. `clipboard.paste` takes `{udid, text?}`:
omitting text pastes the existing simulator clipboard, while `""` writes and
pastes an empty string. Write and Paste return `{ok: true, cleanupWarning?}`.
These are in-process actions under the usual `/exec-ws` token and Origin policy.

The UDID must identify one simulator and is normalized to uppercase. Text is
limited to 4 MiB of UTF-8; the 4 MiB `/exec-ws` message limit also includes the
JSON envelope and escaping. Copy and Paste start the device input session if
needed, wait for capture readiness, and share the viewer input queue and
pasteboard lock. A session created before its viewer uses the owning middleware's
configured transport and encoder settings; action parameters cannot supply those
settings [observed: `src/middleware.ts`, `src/socket/server-control.ts`,
`src/host-actions.ts`]. Errors return a nonzero `exitCode` and explanatory `stderr`,
including any key cleanup warning. See [LLP 0010](0010-serve-sim-clipboard.explainer.md).

### Action catalog

`actions.describe` with `{}` returns a JSON object that maps each action name to
the JSON Schema of its parameters (`z.toJSONSchema` with `io: "input"`). A client
reads it, so a new action needs no client change.
Each schema also carries these keys from `.meta()` in `src/host-actions.ts`:

- `description`: one sentence for a user.
- `args`: the order in which a client fills parameters from values given in
  order, for actions whose schema has several shapes. Other actions use the
  order of `properties`. The client fills `udid` itself, so `args` leaves it
  out and the client skips it in `properties`.
- `upload`: the parameter that takes a file. A client uploads a local file with
  `upload.append` and sends the staged path, or the upload ID when `uploadAs`
  is `"id"`. `uploadWhen` lists parameter values that must match first, for
  example `{source: "file"}`. `keepUpload: true` means the action keeps reading
  the file, so the client does not send `upload.remove` after a success.
- `output`: `"path"` when stdout is a file path on the host to read with
  `file.readBase64`, or `"base64"` when stdout is the file.

Patterns come from JavaScript regular expressions; some, such as the one in
`Argument`, need the `u` flag.

The catalog leaves out actions with `hidden: true`: `server.*`, `reveal`,
`home.watch`, `app.iconPath`, `camera.listWebcams`, `camera.stopWebcam`,
`screenshot.thumbnail`, `upload.*` and `actions.describe`. They still run when
called.

`screenshot.capture` makes a file name when `fileName` is missing.


## Guest profiling

The authenticated control action `profile.capture` accepts `{seconds: 1..30}`
(default 15), and returns raw NDJSON in `stdout`. It runs only on detected VMs,
allows one capture per preview process across all sockets, and rejects a response
over 16 MiB. The server chooses a private temporary output and removes it after
reading; clients cannot choose a path or command. Expected VM, busy-slot and
response-size refusals return a nonzero action result with a fixed diagnostic;
unexpected internal errors stay private. Disconnecting does not cancel the bounded
capture. A preview token holder can see guest process executable
paths and resource counters; arguments and environment variables are not recorded.
GPU allocations are not GPU utilization, and short-lived tasks can be missed
[observed: `src/guest-profile-capture.ts`, `src/guest-metrics.ts`, `src/host-actions.ts`].
