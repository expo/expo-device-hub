# serve-emu

Host your Android emulator or attached Android device for agent workflows like Codex, Cursor, Claude Desktop, and browser-based QA. `serve-emu` streams the screen locally, over your LAN, or through your tunnel of choice, then accepts low-latency input and device-control commands over HTTP and WebSocket.



https://github.com/user-attachments/assets/5646d44c-7fd1-4e97-8705-b44b47c7fdc6



```sh
bunx serve-emu@latest
# or: npx serve-emu@latest
# -> Preview at http://localhost:3300
```

Use `@latest` for one-off runs so Bun/npm fetches the newest published version instead of reusing a cached or locally installed copy.

By default, `serve-emu` starts the vendored scrcpy server on the device and
streams H.264 through an adb tunnel. Android Emulators can instead use the
built-in emulator gRPC screenshot and input APIs, with H.264 encoded by ffmpeg
on the host. Both sources feed the same WebSocket/WebCodecs or WebRTC browser
pipeline, with a Media Source Extensions fallback. Neither input path shells
out to `adb shell input`, keeping taps, swipes, text, and key events responsive
enough for agents.

## Status

Current package version: see [`packages/serve-emu/package.json`](packages/serve-emu/package.json) and [`packages/serve-emu/CHANGELOG.md`](packages/serve-emu/CHANGELOG.md).

Working:

- Live H.264 video over WebSocket/WebCodecs or WebRTC, with an MSE fallback
- Per-tab switching between WebSocket and WebRTC, with lazy WebRTC startup
- Runtime switching between scrcpy and host-side gRPC screenshot capture on Android Emulators, with scrcpy or gRPC input while gRPC video is active
- Runtime PNG/MMAP/RGB888 selection and redacted JSON stream-stat downloads in the UI
- Tap, swipe, text, keyevent, Back, Home, Recents, and Power input
- Keyboard passthrough in the browser UI: editing/navigation keys, Ctrl/Cmd shortcuts (select all, copy, paste, cut, undo, redo), and IME composition for CJK text
- Multi-client streaming, so multiple browser tabs can share one device
- SPS/PPS replay and metadata headers for clients joining mid-stream
- Device discovery, current-device switching, and AVD start/stop controls
- Screenshot, foreground app, accessibility tree, and logcat APIs for agent inspection
- Orientation, dark/light mode, font scale, and network on/off controls
- Emulator GPS location control and route playback from GPX, GeoJSON, KML, or waypoint JSON
- Session recording and replay for REST, WebSocket, and location events
- APK install, app launch, clear data, force stop, permission grant, and media/file import helpers
- Query-scoped multi-device routing and embeddable middleware exports

Planned:

- Compiled single binary

## Requirements

- Bun 1.3.13+
- `adb` on PATH from Android platform-tools
- A booted device/emulator from `adb devices`, or an AVD name passed with `--avd`
- A modern browser with H.264 WebRTC support or WebCodecs; MSE is used when WebCodecs is unavailable
- `ffmpeg` with `libx264` when using `--stream-mode grpc-screenshot` (the default software encoder)
- For `--encoder hardware`: macOS uses VideoToolbox (included in Homebrew ffmpeg); Linux tries NVENC, then VAAPI. NVENC requires the NVIDIA driver. On Ubuntu/Debian, install `ffmpeg` and a VAAPI driver such as `intel-media-va-driver-non-free` or `mesa-va-drivers` for Intel/AMD, with access to `/dev/dri/renderD128` through the `render` group. Docker also needs `--device /dev/dri`.

Hardware selection runs a short encode probe and requires a working hardware backend. It never falls back to software. `SERVE_EMU_HARDWARE_ENCODER=videotoolbox|nvenc|vaapi` pins a backend; `SERVE_EMU_VAAPI_DEVICE` overrides the VAAPI device path.

Node.js 18+ can invoke the published package through `npx`, but local development and server runtime use Bun.

## Package API

The CLI remains the simplest entry point, and the fork also publishes a small
typed integration surface:

- `serve-emu` and `serve-emu/middleware`: `createApp`, `createRouter`, gRPC image-mode types/constants, and socket adapters for embedding the device router in another Bun/Node server
- `serve-emu/stream-socket`: Bun and `ws` socket adapters
- `serve-emu/stream-settings`: WebSocket/WebRTC settings, ICE types, defaults, and validation helpers

Unlisted deep imports such as `serve-emu/src/adb.ts` are blocked by the export
map. The HTTP, WebSocket, and WebRTC signaling endpoints documented below are
also supported runtime APIs.

## Quick Start

One-off run from npm:

```sh
bunx serve-emu@latest
# or
npx serve-emu@latest
```

Local development from the `expo-device-hub` monorepo root:

```sh
bun run submodule:init
bun install --frozen-lockfile
bun run --filter serve-emu setup
bun run --filter serve-emu start
# -> http://localhost:3300
```

`setup` downloads the pinned `scrcpy-server-v4.0` into `packages/serve-emu/vendor/` and builds the browser UI. The CLI also runs the scrcpy setup lazily on first start, so you can skip the setup step for a quick local run.

## CLI

```text
serve-emu [-p <port>] [--host <addr>] [--token <secret>] [-s <serial>] [--stream-mode scrcpy|grpc-screenshot] [--grpc-image-mode png|mmap|rgb888] [--input-source scrcpy|grpc] [--encoder software|hardware] [--max-fps N] [--bit-rate N] [--max-size N] [--key-frame-interval sec] [--repeat-frame-ms ms] [--max-apk-upload-bytes N] [--max-media-upload-bytes N]
serve-emu --transport webrtc [--stun-url url[,url...]] [--turn-url url[,url...] --turn-username user --turn-credential pass]
serve-emu --avd <name> [--gpu <mode>] [--restart-avd] [--camera] [--camera-image <path.png>]
serve-emu --avd-list
serve-emu --running-avds
```

| flag | default | meaning |
| --- | --- | --- |
| `-p, --port` | `3300` | HTTP port for the preview server |
| `--host` | `127.0.0.1` | Address to bind. Defaults to loopback so the device is not exposed. Set `0.0.0.0` to serve over the LAN — see [Access control](#access-control) |
| `--token` | none | Shared secret required on every data-bearing request. Auto-generated for non-loopback binds if omitted |
| `--unsafe-no-auth` | false | Allow a non-loopback bind with **no** authentication (dangerous) |
| `-s, --serial` | auto | adb device serial; required when multiple devices are online |
| `--stream-mode` | `scrcpy` | Screen capture source: `scrcpy`, or emulator-only host capture through `grpc-screenshot` |
| `--encoder` | `software` | Host H.264 encoder for gRPC streaming: `software` uses libx264; `hardware` requires VideoToolbox, NVENC, or VAAPI. No software fallback |
| `--grpc-image-mode` | `png` | gRPC screenshot image delivery: compressed in-band `png`, raw pixels through shared-memory `mmap`, or raw pixels in each gRPC message with `rgb888`. The selected mode is strict; capture errors do not fall back to another mode |
| `--input-source` | `scrcpy` | Input transport for gRPC streaming: a control-only `scrcpy` server, or the emulator's `grpc` endpoint |
| `--max-fps` | `60` | Frame-rate target for capture and encoding; RGB888 forwards received frames whenever ffmpeg is ready without a local FPS cap |
| `--bit-rate` | `8000000` | H.264 bit rate in bps |
| `--max-size` | `1280` | Downscale the longest edge to N pixels; `0` keeps native size. The default balances detail and throughput, especially for the host-side software encoder used by `grpc-screenshot` |
| `--key-frame-interval` | `10` | Ask the encoder for regular keyframes; `0` disables this codec option. Late joiners get keyframes on demand, so a long interval avoids periodic keyframe bursts |
| `--repeat-frame-ms` | `0` | Re-encode the previous frame after N ms without screen changes (`16` ≈ steady 60fps on static screens, at extra CPU/bandwidth cost); `0` keeps the source default: 100ms for scrcpy and 500ms for `grpc-screenshot` |
| `--transport` | `websocket` | Initial browser video transport: `websocket` or `webrtc`. Each tab can switch independently in the UI |
| `--stun-url` | public STUN defaults | Comma-separated STUN URL(s) for WebRTC ICE |
| `--turn-url` | none | Comma-separated TURN URL(s); requires both TURN credential flags |
| `--turn-username` | none | TURN username |
| `--turn-credential` | none | TURN credential |
| `--webrtc-ice-policy` | `all` | ICE policy: `all` or `relay` (`relay` requires TURN) |
| `--max-apk-upload-bytes` | `536870912` | Maximum APK file bytes accepted by the streaming multipart endpoint |
| `--max-media-upload-bytes` | `1073741824` | Maximum media/file bytes accepted by the streaming multipart endpoint |
| `--max-active-uploads` | `2` | Maximum upload operations reading, staging, or running through ADB concurrently |
| `--max-queued-uploads` | `4` | Maximum uploads waiting for an active slot; further requests receive `429` |
| `--upload-queue-timeout-ms` | `5000` | Maximum time an upload may wait for a slot before receiving `503` |
| `--avd` | none | Launch this Android Virtual Device before streaming |
| `--gpu` | `host` | Emulator GPU mode for `--avd` launches. `host` renders on the real GPU for smooth ~60fps; see [Smooth Emulator Playback](#smooth-emulator-playback) |
| `--restart-avd` | false | Stop a running matching AVD before launching it |
| `--avd-list` | false | List available Android Virtual Device names |
| `--running-avds` | false | List currently running emulator serials and AVD names |
| `--emulator` | auto | Android Emulator binary path; defaults to PATH or Android SDK env vars |
| `--emulator-port` | auto | Android Emulator console port for `--avd`; must be an even port from 5554 through 5682 |
| `--camera` | false | Feed the emulator cameras from PNG files serve-emu owns, so the picture can change while the emulator runs. Requires `--avd`; see [Camera Image](#camera-image) |
| `--camera-image` | none | Implies `--camera` and preloads this PNG as the back camera |

By default, `serve-emu` attaches to the only online device. If more than one device is online, pass `-s <serial>` or select another running device later through the HTTP API/UI.

## Access control

`serve-emu` grants full control of the connected device — input, screenshots, APK installation, file import, app-data clearing, logcat, and session controls. Treat access to the port as access to the device.

**Default (loopback).** With no flags the server binds to `127.0.0.1`, so only processes on the same machine can reach it. No authentication is required, and local CLI/agent workflows keep working with no setup. Cross-origin browser requests and WebSocket upgrades are still rejected (the Origin must match the host), so a random web page cannot drive your device through the local port.

**Exposing over the LAN or a tunnel.** Pass `--host 0.0.0.0` (or a specific interface address). A non-loopback bind **requires authentication**:

- If you pass `--token <secret>`, that secret is required on every data-bearing request. The origin-checked `OPTIONS /webrtc/stats` CORS preflight is the only exception: it returns no statistics and lets browsers issue the bearer-authenticated cross-origin `GET`.
- If you omit `--token`, a random token is generated and printed once at startup.

The startup line prints a ready-to-use URL with the token, for example:

```text
serve-emu → http://localhost:3300/?token=qNEvGN1TSgqRc3NHeZiXOfX2tkQUnv68  (device: emulator-5554)
```

How clients authenticate:

- **Browser (bundled UI):** open the printed `?token=` URL once. The server exchanges the token for a `HttpOnly; SameSite=Strict` session cookie and redirects to a clean URL, so the secret is not kept in local storage or the address bar. Same-origin API, SSE, and WebSocket calls then carry the cookie automatically.
- **Agents / CLI (`curl`, HTTP clients):** send `Authorization: Bearer <token>`, or append `?token=<token>` to the URL.

Data-bearing requests without a valid token get `401`; WebSocket upgrades and state-changing requests from a mismatched `Origin` get `403` before any work is done.

**Unauthenticated LAN exposure.** `--host 0.0.0.0 --unsafe-no-auth` binds to all interfaces with no authentication. Anyone who can reach the port can control the device. Only use this on a trusted, isolated network; the CLI prints a warning at startup.

**Token handling.** The token is never included in `/health`, `/api` responses, error payloads, or reconnect URLs — only in the one-time startup line. Rotate it by restarting with a new `--token` (or letting a fresh one be generated); existing cookies stop working immediately. When exposing beyond your machine, prefer an SSH tunnel or an authenticating reverse proxy over a raw `0.0.0.0` bind.

## Smooth Emulator Playback

The single biggest factor for stutter-free emulator streaming is the **emulator GPU mode**, not the bit rate or the transport. Many AVDs default to `auto`, which on some hosts (notably Apple Silicon) falls back to a **software Vulkan compositor** (`llvmpipe`/`lavapipe`). That caps the guest at a janky ~20fps with dropped frames, so the stream stutters no matter how high you set `--max-fps` or `--bit-rate`.

`serve-emu` launches `--avd` emulators with **`-gpu host`** by default, which renders on the real GPU (Metal/Vulkan) for smooth ~60fps playback (measured: guest jank dropped from 10–19% to 0%). Override with `--gpu <mode>` when needed:

```sh
# default — real GPU, smooth
serve-emu --avd Pixel_8

# headless host without a usable GPU
serve-emu --avd Pixel_8 --gpu swiftshader_indirect
```

If you start the emulator yourself (or attach to a pre-booted one with `-s`), `serve-emu` can't set its GPU mode — launch it with `-gpu host` directly:

```sh
emulator @Pixel_8 -gpu host
```

You can confirm the mode in the emulator log (`vulkan_mode_selected:host` = good; `lavapipe`/`llvmpipe` = software fallback) or via `adb shell dumpsys gfxinfo <pkg>` (look for a low "Janky frames" percentage while scrolling). For an extra fps margin, lower `--max-size` to stream at a smaller resolution.

## Browser UI

Open `http://localhost:3300` after starting the CLI. The UI streams the device into a canvas and exposes controls for:

- Pointer input, keyboard passthrough (typing, navigation keys, shortcuts, IME composition), hardware buttons, and screenshots
- Device selection plus AVD start/stop
- Stream-source switching between scrcpy and gRPC screenshot capture on emulators, with an explicit PNG/MMAP/RGB888 image-mode selector for gRPC
- Per-tab WebSocket/WebRTC selection and redacted stream-stat downloads
- Orientation, night mode, font scale, network, GPS location, and route playback
- Logcat filtering, pause/copy controls, app management, file import, and session replay

The browser decoder treats every WebSocket reconnect, device video session, and
hard decoder recovery as a new stream generation. Codec, latency, frame counts,
and rendered state are cleared at each boundary; the UI reports `streaming`
only after a frame from the current generation reaches the canvas. A connected
session with no frame becomes `waiting for video`, while fresh packets that do
not produce frames become `stream stalled`. Late events from older generations
are ignored. Input sent while the video WebSocket is disconnected is dropped
instead of being replayed against a later device session.

## HTTP API

All examples assume the default port:

```sh
BASE=http://localhost:3300
```

### Health And Discovery

```sh
curl "$BASE/health"
curl "$BASE/api"
curl "$BASE/api/devices"
curl "$BASE/api/device-grid"
curl "$BASE/api/stream-mode"
curl -X PUT "$BASE/api/stream-mode" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"grpc-screenshot","grpcImageMode":"mmap","inputSource":"scrcpy"}'
curl -X POST "$BASE/api/devices/select" \
  -H 'Content-Type: application/json' \
  -d '{"serial":"emulator-5554"}'
```

`GET /api/stream-mode` reports `mode`, `grpcImageMode`, `inputSource`, `encoder`,
`encoderName`, `availableEncoders`, the available stream and input sources, and the
active session generation. `encoderName` identifies the active ffmpeg backend, or is
`null` for scrcpy. `availableEncoders` includes `software` and `hardware` so a failed
hardware request can be retried. `hardwareEncoderError` is advisory: it describes
the latest hardware probe or runtime encoder failure and clears after a successful
hardware probe. Unexpected hardware encoder failures invalidate the cached probe,
so the next hardware request probes again.
`/health` and `/api` also report the active `encoderName`.

`PUT /api/stream-mode` accepts optional `grpcImageMode` (`png`, `mmap`, or `rgb888`),
`inputSource` (`scrcpy` or `grpc`), and `encoder` (`software` or `hardware`) when
`mode` is `grpc-screenshot`. Omitted settings keep their configured values.
gRPC streaming defaults to software encoding and the control-only scrcpy input
transport. Changing these settings stages a replacement capture atomically; any
failure is returned while the current capture keeps running. Hardware never falls
back to software, and MMAP never falls back to PNG.

```sh
curl -X PUT "$BASE/api/stream-mode" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"grpc-screenshot","encoder":"hardware"}'
```

`/health` includes bounded subprocess executor activity, queue depth, lane
counts, deadlines, overload rejections, and output-limit totals. Device-grid
refreshes reuse one `adb devices` snapshot while resolving running AVD names.
Long install/import work uses a background lane; the default executor reserves
one active slot and eight queue positions for interactive work such as GPS.

### Runtime Stream Settings

The standalone CLI and exported multi-device `createRouter` middleware expose
the same encoder-settings endpoint. The router uses `?device=<serial>` for
device-scoped requests. The standalone server applies requests to its currently
selected device and accepts `?device=` when it matches that device.

```sh
curl "$BASE/api/stream-settings?device=emulator-5554"

curl -X PATCH "$BASE/api/stream-settings?device=emulator-5554" \
  -H 'Content-Type: application/json' \
  -d '{"maxDimension":960,"h264Bitrate":6000000,"h264Fps":60}'
```

`GET /api/stream-settings` returns the active encoder settings:

```json
{
  "ok": true,
  "maxDimension": 1280,
  "h264Bitrate": 8000000,
  "h264Fps": 60
}
```

`PATCH /api/stream-settings` accepts a non-empty subset of those fields. Values
must be integers within these bounds:

| Field | Range | Meaning |
| --- | ---: | --- |
| `maxDimension` | 0–4096 | Longest encoded edge; `0` disables the size cap |
| `h264Bitrate` | 100000–50000000 | Target H.264 bitrate in bits per second |
| `h264Fps` | 1–120 | Maximum encoded frames per second |

A changed setting restarts only the active capture while keeping the device's
recorded-session state. Middleware clients remain attached and resynchronize on
the replacement dimensions and a fresh keyframe. The standalone server
atomically publishes the replacement session, then reconnects existing clients.
Input is rejected while middleware capture is restarting. A failed replacement
keeps or restores the previous settings; if replay is active, PATCH returns
`409` without restarting capture. Shutdown and stopped-session races return
`503`. Other failures use bounded JSON responses shaped as
`{"ok":false,"error":"<code>"}` and include a `message` when more detail is
available. Health includes the authoritative `encoderSettings` snapshot;
middleware health also includes `captureRestarting`.

AVD lifecycle helpers:

```sh
curl -X POST "$BASE/api/avds/start" \
  -H 'Content-Type: application/json' \
  -d '{"avd":"Pixel_8","select":true}'

curl -X POST "$BASE/api/avds/stop" \
  -H 'Content-Type: application/json' \
  -d '{"serial":"emulator-5554"}'
```

### Input

Coordinates are normalized from `0` to `1` and converted to screen pixels by the server.

```sh
curl -X POST "$BASE/api/tap" \
  -H 'Content-Type: application/json' \
  -d '{"x":0.5,"y":0.5}'

curl -X POST "$BASE/api/swipe" \
  -H 'Content-Type: application/json' \
  -d '{"x1":0.5,"y1":0.8,"x2":0.5,"y2":0.2,"durationMs":350}'

curl -X POST "$BASE/api/text" \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello"}'

curl -X POST "$BASE/api/key" \
  -H 'Content-Type: application/json' \
  -d '{"key":"back"}'
```

Arbitrary keycodes accept an optional `action` (`"down"` or `"up"`; omit for an immediate press) and an optional `metaState` bitmask using Android's `AMETA_*` values (`0x1` shift, `0x2` alt, `0x1000` ctrl):

```sh
# Ctrl+A (select all)
curl -X POST "$BASE/api/key" \
  -H 'Content-Type: application/json' \
  -d '{"keycode":29,"metaState":4096}'

# Hold DPAD_DOWN down, then release it later
curl -X POST "$BASE/api/key" -H 'Content-Type: application/json' -d '{"keycode":20,"action":"down"}'
curl -X POST "$BASE/api/key" -H 'Content-Type: application/json' -d '{"keycode":20,"action":"up"}'
```

### Inspection

```sh
curl "$BASE/api/screenshot" --output screen.png
curl "$BASE/api/screenshot?format=base64"
curl "$BASE/api/foreground"
curl "$BASE/api/accessibility"
curl -X POST "$BASE/api/accessibility/tap" \
  -H 'Content-Type: application/json' \
  -d '{"selector":{"resourceId":"com.example:id/login"}}'
curl -X POST "$BASE/api/accessibility/tap" \
  -H 'Content-Type: application/json' \
  -d '{"selector":{"textContains":"Continue","clickable":true}}'
curl -N "$BASE/api/logcat?package=com.example.app&search=error"
curl -N "$BASE/api/metrics"
```

Logcat subscriptions share one `adb logcat` child for the active device.
New children start at the live tail instead of replaying the device's buffered
history. Matching lines are delivered in short `logs` SSE batches; each
subscriber has bounded line and byte queues, and batch payloads report
queue/source drop counts. `/health` exposes the active child, subscriber count,
queued bytes, limits, and cumulative delivery/drop totals under `logcat`.
Pausing Logcat in the browser closes its SSE connection, so paused panels do
not keep receiving and discarding device output.

`/api/metrics` is an SSE stream of the foreground app's resource use, one
`data:` frame per second with `{t, bundleId, cpuPct, memBytes, netInBytesPerSec,
netOutBytesPerSec}` after an `event: meta` frame that carries the guest core
count as `hostCores`. The foreground app is identified by the same detector
`/api/foreground` uses, so the two never name different packages. `cpuPct` is
percent of one guest core, so it can exceed 100 on a multi-core emulator. Network counters are device-wide (`/proc/net/dev`
minus `lo`); the emulator exposes no per-app counters. CPU and memory come from
the process that `pidof <package>` resolves, so an app that declares
`android:process` for its activity reports zero, and a multi-process app such as
Chrome excludes its renderer children. Subscribers share one sampler per device,
and sampling stops when the last stream closes. A device accepts eight metrics
subscribers; the ninth is refused with `metrics-subscriber-limit` and HTTP 429.

### Device Settings

```sh
curl "$BASE/api/orientation"
curl -X POST "$BASE/api/orientation" \
  -H 'Content-Type: application/json' \
  -d '{"orientation":"landscape"}'

curl "$BASE/api/night-mode"
curl -X POST "$BASE/api/night-mode" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"dark"}'

curl "$BASE/api/font-scale"
curl -X POST "$BASE/api/font-scale" \
  -H 'Content-Type: application/json' \
  -d '{"scale":1.2}'

curl "$BASE/api/network"
curl -X POST "$BASE/api/network" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}'

curl "$BASE/api/software-keyboard"
curl -X POST "$BASE/api/software-keyboard" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}'
```

The software keyboard toggle writes `secure show_ime_with_hard_keyboard`.
Android hides the on-screen IME while a hardware keyboard is attached, and `1`
shows it anyway. Set it when a device reports a hardware keyboard and you still
need the on-screen keyboard.

### Location And Routes

Location control uses the Android Emulator `geo fix` command and is currently emulator-only.

```sh
curl "$BASE/api/location"
curl -X POST "$BASE/api/location" \
  -H 'Content-Type: application/json' \
  -d '{"latitude":37.5665,"longitude":126.978}'
```

Start route playback from waypoints:

```sh
curl -X POST "$BASE/api/route" \
  -H 'Content-Type: application/json' \
  -d '{"speedKph":30,"multiplier":1,"loop":false,"waypoints":[{"latitude":37.5665,"longitude":126.978},{"latitude":37.5651,"longitude":126.98955}]}'
```

Read, pause, resume, or stop playback:

```sh
curl "$BASE/api/route"
curl -X POST "$BASE/api/route/control" \
  -H 'Content-Type: application/json' \
  -d '{"action":"pause"}'
curl -X DELETE "$BASE/api/route"
```

The browser route importer accepts GPX, KML, GeoJSON, and waypoint JSON files
up to 2 MiB. It rejects oversized files before reading them, parses in a
cancellable Web Worker, and enforces the 10,000-waypoint, nesting, and
complexity limits during traversal. Playback receives the complete validated
waypoint sequence. Map display is separate: it caches projection by route and
zoom, simplifies the line to at most 1,024 screen-space points, and pans it with
one CSS transform per animation frame. The interaction target is one 16.7 ms
frame at 60 Hz. Follow route is explicit; manually panning turns it off so the
one-second status poll does not force the map center back onto the route.

### Camera Image

Camera image passthrough replaces the emulator's camera feed with a PNG you
supply, so an app under test sees a known picture in both its preview and its
captures. It is emulator-only, and it must be requested at launch:

```sh
serve-emu --avd Pixel_8 --camera
serve-emu --avd Pixel_8 --camera-image ~/fixtures/id-card.png
```

`--camera` starts the emulator with `-camera-back` and `-camera-front` pointed
at two PNG files under `~/.cache/serve-emu/camera/` (override the directory with
`SERVE_EMU_CAMERA_DIR`). The emulator only reads its camera source at startup,
so feeds cannot be added to an emulator that is already running. Asking for the
camera against one an earlier launch already wired still succeeds: serve-emu
reads the wiring back off the emulator instead of refusing, so a restart keeps
working. Use `--restart-avd` for an emulator that is running unwired.

The embeddable middleware (`createRouter`, the package's default export) serves
the same routes, scoped per `?device=<serial>`. A host that launches the
emulator itself calls `seedCameraFeeds(serial)` first and adds
`cameraLaunchArgs(serial)` to its emulator command. Nothing else: serve-emu
reads the wiring back off the emulator, so no host has to declare it.

Once wired, changing the picture is a plain file write, so no restart is needed:

```sh
curl "$BASE/api/camera"
curl "$BASE/api/camera/image?facing=back" --output current.png
curl -X POST "$BASE/api/camera/image?facing=back" \
  -H 'Content-Type: image/png' --data-binary @fixture.png
curl -X DELETE "$BASE/api/camera/image?facing=front"
```

`GET /api/camera` reports, per facing, the feed path and the current image's
size, byte count, and sha256. `GET /api/camera/image?facing=` returns the
current PNG for one facing. `wiredAtLaunch` is read from the running emulator's
`hardware-qemu.ini`, the effective hardware config it writes at launch, so it is
true for any launch route (serve-emu's own, or a host's own emulator command)
and survives a serve-emu restart. When it is false the response still lists the
`launchArgs` that would attach the feeds. `DELETE` restores a generated
checkerboard test card that means "no image set".

Three constraints come from the emulator, not from serve-emu:

- **PNG only.** The emulator's `imagefile` camera loads PNG and nothing else; a
  JPEG body is rejected with `400`. Convert first with `sips -s format png
  in.jpg --out out.png` or `magick in.jpg out.png`.
- **The guest re-reads the file when it opens the camera device.** An app
  already showing a preview keeps the old picture. Reopen the camera screen, or
  restart the app with `POST /api/apps/force-stop` and `POST /api/apps/launch`.
- **4:3 landscape is the sensor's shape.** The emulator scales a source to fill
  a 4:3 frame and crops the overflow, then the app crops that again for its own
  preview aspect, exactly as it would crop a real sensor. A 4:3 image reaches
  the guest uncropped.

An absent or unparsable feed file makes the emulator render a solid magenta
frame, so serve-emu keeps a valid PNG at both paths from the moment it wires
them.

Feed files outlive the process. They stay in `~/.cache/serve-emu/camera/`, named
by emulator serial, holding whatever image was posted last, so delete them by
hand if a fixture is sensitive. A launch always rewrites both feeds rather than
adopting what it finds, because serials are recycled and the file left behind
belongs to an unrelated earlier run.

### Sessions

REST and WebSocket input events are recorded by default. Add `"record":false`
to supported input payloads when an event should not be saved. History uses a
2,000-event, 1 MiB circular retention budget; `/health` contains only its
compact count/byte/replay summary. Text is normalized to scrcpy's 300-byte
UTF-8 control limit before both dispatch and recording.

```sh
curl "$BASE/api/session?limit=6"
curl "$BASE/api/session?limit=50&before=1200"
curl "$BASE/api/session/export"
curl -X POST "$BASE/api/session/replay" \
  -H 'Content-Type: application/json' \
  -d '{"multiplier":2}'
curl -X POST "$BASE/api/session/replay/stop"
curl -X DELETE "$BASE/api/session"
```

Session pages are returned in chronological order with an exclusive
`nextBefore` cursor and `hasMore` flag. The bounded full history is serialized
only by the explicit export endpoint (and by the UI's Copy action), rather than
on every poll. The UI requests only its six visible recent events and pauses
polling while the Session panel or browser tab is hidden. `/health` exposes the
last/max UTF-8 response bytes and JSON serialization time for health, session
page, and export responses under `responseMetrics`. The health entry describes
the previous completed `/health` response because the current body is measured
after it is serialized.

### Apps And Files

```sh
curl -X POST "$BASE/api/apps/install" \
  -F apk=@/path/to/app.apk

curl -X POST "$BASE/api/apps/launch" \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app","activity":".MainActivity"}'

curl -X POST "$BASE/api/apps/clear" \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app"}'

curl -X POST "$BASE/api/apps/force-stop" \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app"}'

curl -X POST "$BASE/api/apps/grant" \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app","permission":"android.permission.POST_NOTIFICATIONS"}'

curl -X POST "$BASE/api/apps/revoke" \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app","permission":"android.permission.POST_NOTIFICATIONS"}'

# Runtime permissions with their granted state and flags, from `dumpsys package`.
curl "$BASE/api/apps/permissions?packageName=com.example.app"

# Per-package reset: each runtime permission returns to its manifest default,
# user decisions are cleared, and app ops are reset. Permissions already at
# their default are left alone; each revoke stops the app.
curl -X POST "$BASE/api/apps/reset-permissions" \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app"}'

curl -X POST "$BASE/api/files/import" \
  -F file=@/path/to/image.png
```

Uploads stream to private asynchronous temporary files and are removed after
ADB completes. Actual bytes are enforced even without `Content-Length`; a
device switch or server shutdown cancels work against the captured old device.
Oversized requests receive `413`, and upload capacity errors are structured
JSON responses. `/health` includes current upload queue metrics.

## WebSocket API

Connect to `/ws` for the raw Annex-B H.264 stream. Send JSON control messages over the same socket:

```json
{"type":"tap","x":0.5,"y":0.5}
{"type":"swipe","x1":0.5,"y1":0.8,"x2":0.5,"y2":0.2,"durationMs":350}
{"type":"text","text":"hello"}
{"type":"key","keycode":66}
{"type":"key","keycode":29,"metaState":4096}
{"type":"key","keycode":20,"action":"down"}
{"type":"back"}
{"type":"reset-video"}
```

Use `/ws?frame-meta=1` to receive a 24-byte `SEMU` v2 frame metadata header before each H.264 access unit: magic `SEMU` (4B), version=2 (1B), flags (1B, bit 0 = keyframe), reserved (2B), PTS (8B BE, µs), and the server send time (8B BE, epoch µs). Same-host clients can compare the send time against their own clock to measure transit and glass-to-glass latency. The bundled UI uses this mode to avoid per-frame NAL scans and to track PTS/keyframe/latency state.

For H.264 sources, each browser tab can independently select WebSocket or
WebRTC; `--transport` chooses only the initial selection for tabs without a
saved preference. The server starts its WebRTC publisher lazily on the first
authenticated, same-origin `POST /webrtc/offer`, and releases a viewer through
`POST /webrtc/close`. A WebRTC viewer keeps `/ws?video=0` open as a control-only
socket, so input still travels through the active low-latency source control
path without duplicating video over WebSocket. `/api` exposes the default,
available viewer transports, and ICE configuration to the authenticated UI;
`/health` redacts TURN credentials.

The UI's **Download stats** action writes a versioned, redacted JSON snapshot
containing bounded viewer metrics, `/health`, and statistics for only the
current WebRTC session when applicable. If a server sample is unavailable, the
file is still downloaded with a safe error summary and the data that was
available. Files use `schemaVersion: 1` and the name
`serve-emu-<device>-<transport>-<timestamp>.json`. The exporter deliberately
does not request `/api`, so it never collects the ICE/TURN configuration used
to initialize the viewer.

Authenticated clients can read one live viewer directly with
`GET /webrtc/stats?sessionId=<uuid>`; multi-device middleware also accepts an
explicit `device` query. Invalid requests return `400`, while an unknown,
closed, or otherwise unavailable viewer returns `503`. Reading stats never
starts an idle WebRTC publisher.

See the [protocol reference](packages/serve-emu/docs/protocol.md) for the complete scrcpy v3/v4 framing, control packet, and `SEMU` v1/v2 wire formats.

## How It Works

```text
+------------------+ adb forward  +-------------+ H.264 WS/RTC +---------+
| scrcpy-server.jar| <----------> | serve-emu  | ------------> | Browser |
| on device        | TCP tunnel   |   (Bun)     | WebCodecs/MSE | canvas/ |
|                  |              |             | or WebRTC     | video   |
|  - video socket  |              |             | <------------ |         |
|  - control socket|              |             |  input JSON   |         |
+------------------+              +-------------+               +---------+
```

1. The CLI pushes `scrcpy-server-v4.0` to `/data/local/tmp/scrcpy-server.jar`.
2. It opens `adb forward tcp:<localPort> localabstract:scrcpy_<scid>`.
3. It spawns `app_process` with the scrcpy server class on the device, then connects video and control sockets through the tunnel.
4. The Bun server reads scrcpy's framed H.264 stream and publishes each access unit to active WebSocket viewers and, once requested, WebRTC viewers. Raw `/ws` clients receive Annex-B payloads unchanged; the built-in WebSocket UI opts into the 24-byte frame metadata header.
5. The browser uses WebCodecs in a worker, falls back to MSE where necessary, or renders the WebRTC track into a `<video>`. Pointer events are normalized to unit coordinates and dispatched through the active source's ordered control channel.

With `--stream-mode grpc-screenshot`, the emulator's gRPC endpoint provides
images while input defaults to a control-only scrcpy session and can be switched
to emulator gRPC. Set the initial choice with `--input-source scrcpy|grpc`.
`--grpc-image-mode png`
requests compressed images in the gRPC stream, while `--grpc-image-mode mmap`
requests raw RGB pixels through the emulator's shared-memory side channel.
`--grpc-image-mode rgb888` requests `IMG_FORMAT_RGB888` with the width and height
set to `--max-size`, omitting `transport` from `streamScreenshot`. Each response's
`image` bytes are validated against its actual dimensions (`width * height * 3`)
and passed to ffmpeg as `rgb24`. It uses no MMAP region or verification rereads,
and no PNG encoding or decoding in the continuous stream. Startup/geometry and
inactivity probes also request in-band RGB888. The emulator preserves aspect
ratio within the requested bounds; zero requests native size, including after
rotation or display resizing.

This path still requires GPU-to-CPU readback inside the emulator. It is not GPU
texture sharing, zero-copy, or hardware encoding; speed depends on the workload
and must be measured. All gRPC image modes submit usable images as soon as
ffmpeg can accept them. Backpressure waits for ffmpeg's `drain` event, retaining
only the newest pending image; there is no encoder write pacer or retry polling.
RGB888 keeps consuming screenshots while ffmpeg is blocked, replacing the
pending image so a slow encoder does not create a FIFO of stale frames. Receive
work yields after each 64 KiB batch to let encoder callbacks and other I/O run.
The gRPC connection and stream receive windows are 8 MiB so large RGB frames do
not cycle through the default 64 KiB window. No experimental flags are needed.
A one-shot five-second stall watchdog rechecks encoder readiness after a missed
`drain`; it resumes only if writable, otherwise reports an `encoder-exit` error.
Screenshot inactivity probes remain active while ffmpeg is backpressured.

For RGB888, `--max-fps` configures ffmpeg's nominal input rate and the idle
boundary cadence; it does not cap fresh frame submissions. PNG retains its
predecode message pacer; MMAP selects notifications before reading shared
memory so metadata remains paired with current pixels. Neither sets a
server-side screenshot FPS limit. Health
reports `grpcCapture.imageMode`, actual received `grpcMessageBytesReceived`,
protobuf decode timing, and separate received/source/encoder frame rates.
MMAP counters remain zero and shared-memory timing remains null for RGB888.

For RGB888, `rawGrpcMessagesEmitted` counts responses passed to protobuf decoding
and matches `rawGrpcMessagesReceived`; `rawGrpcMessagesCoalesced` stays zero.
Those message counters exclude images replaced in the latest-image slot before
encoding. Compare `usableImageFps` with `freshEncoderWriteFps` (which excludes
repeats) to observe the local reduction before encoder submission. Their
rolling-rate difference is not an exact cumulative dropped-image count.

```sh
serve-emu -s emulator-5554 --stream-mode grpc-screenshot --grpc-image-mode rgb888
curl -X PUT http://localhost:3300/api/stream-mode \
  -H 'Content-Type: application/json' \
  -d '{"mode":"grpc-screenshot","grpcImageMode":"rgb888"}'
```

The standalone server and embedded `createApp`/`createRouter` accept
`{ streamMode: "grpc-screenshot", grpcImageMode: "rgb888" }`. Both use the same
GET/PUT contract for runtime switching; failed replacements retain the applied
mode. Serve-emu still defaults to PNG; Expo Device Hub defaults to MMAP.

`serve-emu` uses the bearer token advertised by the emulator's discovery file
when one is present. If an explicitly selected emulator exposes an endpoint
without a token, `serve-emu` prints a warning before using that local endpoint;
only select this mode for an emulator you trust.

`serve-emu` encodes all three modes with ffmpeg, using libx264 by default or the
selected hardware backend, into the same Annex-B H.264
packet shape, so browser streaming, backpressure recovery, recording, and the
REST and WebSocket control APIs remain unchanged. The selected gRPC image mode
never falls back automatically. The UI can replace either source or gRPC image
mode or encoder at runtime; the current stream stays live until the replacement is ready.

For MMAP, `--max-size 0` allocates the fixed shared region from the display's
native size at session startup. Rotation remains native-size, but a foldable or
resizable display that later grows beyond that startup extent requires a stream
restart so a larger region can be allocated.

MMAP support is experimental and depends on the Android Emulator build. Google
tracks an Apple Silicon `streamScreenshot` MMAP fix as issue
[#537802959](https://issuetracker.google.com/issues/537802959), included in
Emulator 37.2.3 Canary. If an affected emulator crashes or stops producing
frames, select PNG explicitly or upgrade to a build containing that fix.

## Development

```sh
bun install
bun run --filter serve-emu setup
bun run --filter serve-emu dev
bun run --filter serve-emu typecheck
bun run --filter serve-emu build
bun run check
```

`dev:ui` proxies `/api`, `/health`, `/webrtc`, and `/ws` to
`http://localhost:3300` by default. To run the backend on another port while
keeping the Vite UI on its normal development origin, start the two processes
like this:

```sh
# terminal 1: backend on a non-default port
bun run packages/serve-emu/src/cli.ts --port 4319

# terminal 2: UI with API, health, and WebSocket proxying to that backend
SERVE_EMU_BACKEND_ORIGIN=http://localhost:4319 bun run --filter serve-emu dev:ui
```

`SERVE_EMU_BACKEND_ORIGIN` only selects the Vite development proxy target. It
does not disable the backend's token or same-origin protections; use the normal
CLI access-control flags when exposing the backend beyond loopback.

The repository-root `README.md` is the authoritative product documentation.
After editing it, regenerate and verify the package copy:

```sh
bun run docs:sync
bun run docs:check
```

For runtime or protocol changes, test with a booted emulator or device:

```sh
adb devices
bun run packages/serve-emu/src/cli.ts
```

Useful manual checks include first video frame, browser refresh recovery, multiple tabs, tap/swipe/text/key input, screenshots, logcat SSE, app management, location, route playback, and session replay.

## Package Identity

The npm package, CLI executable, workspace, and supported import specifiers all
use the `serve-emu` name. Publish releases from that workspace:

```sh
npm publish --workspace packages/serve-emu
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup, validation steps, scrcpy protocol notes, and pull request guidelines.

## License

Apache-2.0. Bundles the upstream [scrcpy](https://github.com/Genymobile/scrcpy) server binary (Apache-2.0) at runtime.
