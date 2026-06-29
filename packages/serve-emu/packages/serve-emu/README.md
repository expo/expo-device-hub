# serve-emu

The `npx serve` of Android devices.

Host your Android emulator (or real device) for use with agent tools like Codex, Cursor, or Claude Desktop — locally, over your LAN, or tunnel anywhere.

```sh
bunx serve-emu
# → Preview at http://localhost:3300
```

`serve-emu` spawns the scrcpy server on the device, opens an adb forward tunnel, pipes H.264 frames over a WebSocket, and decodes them in the browser with WebCodecs. Input events flow back over the same socket to scrcpy's control channel.

## Status

v1. Working:

- Live H.264 video stream from device → WebCodecs canvas
- Taps, swipes, hardware buttons (Back / Home / Recents / Power)
- Text injection, keyevents
- Multi-client (multiple browser tabs share one stream)
- Auto-replay of SPS/PPS to clients joining mid-stream
- Emulator GPS location control from the browser UI and `POST /api/location`
- Route playback from GPX, GeoJSON, KML, or waypoint JSON
- Logcat forwarding over SSE with browser-side filter, pause, and copy controls
- Agent-friendly REST input APIs plus session event replay
- App management controls for APK install, launch, clear data, force stop, and permission grants
- Full-resolution screenshot capture from the browser UI (download / copy) and `GET /api/screenshot`

Planned:

- Multi-device routing
- Embeddable Connect-style middleware (`serve-emu/middleware`)
- Compiled single binary

## Requirements

- Node.js 18+ or Bun 1.1+
- `adb` on PATH (Android platform-tools)
- A booted device/emulator (`adb devices` shows it), or an AVD name passed with `--avd`
- Chrome / Edge / Safari 16.4+ (for WebCodecs)

## Quick start

```sh
bun install
bun run --filter serve-emu setup    # downloads scrcpy-server-v3.1 (90KB) into vendor/
bun run packages/serve-emu/src/cli.ts
# → http://localhost:3300
```

The `setup` step is also run lazily on first start, so you can skip it.

## CLI

```
serve-emu [-p <port>] [-s <serial>] [--max-fps N] [--bit-rate N] [--max-size N] [--key-frame-interval sec]
serve-emu --avd <name> [--restart-avd]
serve-emu --avd-list
serve-emu --running-avds
```

| flag | default | meaning |
|---|---|---|
| `-p, --port` | `3300` | HTTP port for the preview server |
| `-s, --serial` | auto | adb device serial (only required when multiple devices are attached) |
| `--max-fps` | `30` | cap source frame rate |
| `--bit-rate` | `8000000` | H.264 bit rate in bps |
| `--max-size` | `1024` | downscale longest edge to N pixels; `0` = native (encoders on many emulators reject above ~2560, so the default trims) |
| `--key-frame-interval` | `1` | ask the encoder for regular keyframes so clients can recover without resetting video capture; `0` disables this codec option |
| `--avd` | none | launch this Android Virtual Device before streaming |
| `--restart-avd` | false | stop a running matching AVD before launching it |
| `--avd-list` | false | list available Android Virtual Device names |
| `--running-avds` | false | list currently running emulator serials and AVD names |
| `--emulator` | auto | Android Emulator binary path; defaults to PATH or Android SDK env vars |
| `--emulator-port` | auto | emulator console port for `--avd`; must be an even port from 5554 through 5682 |

## HTTP API

Set an Android Emulator GPS fix:

```sh
curl -X POST http://localhost:3300/api/location \
  -H 'Content-Type: application/json' \
  -d '{"latitude":37.5665,"longitude":126.978}'
```

Location control uses the Android Emulator `geo fix` command and is currently emulator-only.

Start route playback from waypoints:

```sh
curl -X POST http://localhost:3300/api/route \
  -H 'Content-Type: application/json' \
  -d '{"speedKph":30,"multiplier":1,"loop":false,"waypoints":[{"latitude":37.5665,"longitude":126.978},{"latitude":37.5651,"longitude":126.98955}]}'
```

Pause, resume, or stop playback:

```sh
curl -X POST http://localhost:3300/api/route/control \
  -H 'Content-Type: application/json' \
  -d '{"action":"pause"}'
```

Drive the device with REST:

```sh
curl -X POST http://localhost:3300/api/tap \
  -H 'Content-Type: application/json' \
  -d '{"x":0.5,"y":0.5}'

curl -X POST http://localhost:3300/api/text \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello"}'

curl http://localhost:3300/api/screenshot --output screen.png
```

Stream logcat over SSE:

```sh
curl -N 'http://localhost:3300/api/logcat?package=com.example.app&search=error'
```

Replay recorded input and location events:

```sh
curl -X POST http://localhost:3300/api/session/replay \
  -H 'Content-Type: application/json' \
  -d '{"multiplier":2}'
```

Manage apps:

```sh
curl -X POST http://localhost:3300/api/apps/install \
  -F apk=@/path/to/app.apk

curl -X POST http://localhost:3300/api/apps/launch \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app","activity":".MainActivity"}'

curl -X POST http://localhost:3300/api/apps/clear \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app"}'

curl -X POST http://localhost:3300/api/apps/grant \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"com.example.app","permission":"android.permission.POST_NOTIFICATIONS"}'
```

## How it works

```
┌──────────────────┐ adb forward  ┌─────────────┐  H264 / WS    ┌─────────┐
│ scrcpy-server.jar│ ◄──────────► │  serve-emu  │ ────────────► │ Browser │
│ on device        │  TCP tunnel  │   (Bun)     │   WebCodecs   │ <canvas>│
│  • video socket  │              │             │ ◄──────────── │         │
│  • control socket│              │             │  input JSON   │         │
└──────────────────┘              └─────────────┘               └─────────┘
```

1. The CLI pushes `scrcpy-server-v3.1` to `/data/local/tmp/scrcpy-server.jar`.
2. It opens `adb forward tcp:<localPort> localabstract:scrcpy_<scid>`.
3. It spawns `app_process` with the scrcpy server class on the device, then connects two sockets through the tunnel: video and control.
4. The Bun server reads scrcpy's framed H.264 stream (12-byte header + Annex-B payload) and forwards each Access Unit as a binary WebSocket message. Raw `/ws` clients receive the Annex-B payload unchanged; the built-in browser UI opts into a 16-byte frame metadata header with keyframe and PTS data.
5. The browser configures a `VideoDecoder` from the SPS, uses server-provided frame metadata to avoid per-frame NAL scans, and draws frames to a `<canvas>`. Pointer events are normalized to device coordinates and written back to scrcpy's control socket as 32-byte touch packets.

## License

Apache-2.0. Bundles the upstream [scrcpy](https://github.com/Genymobile/scrcpy) server binary (Apache-2.0) at runtime.
