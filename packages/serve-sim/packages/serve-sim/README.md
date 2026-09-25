# serve-sim

The `npx serve` of Apple Simulators. 

Host your simulator for use with Agent tools like Codex, Cursor, or Claude Desktop — locally, over your LAN, or host on a remote mac and tunnel anywhere. 

```sh
npx @expo/serve-sim
# → Preview at http://localhost:3200
```

https://github.com/user-attachments/assets/fbf890f4-c8c7-4684-82be-d677b8a188f8

`serve-sim` captures the simulator's IOSurface through an in-process Swift addon, exposes it over HTTP or WebRTC, and serves a React preview UI with simulator input. It works with any booted iOS Simulator — no Xcode plugin and no instrumentation in your app.

## Features 

- Low-latency SimulatorKit capture with a 60 Hz IOSurface seed poll and configurable WebRTC cadence.
- Swipe from the bottom to go home.
- gestures like pinch to zoom by holding the option key.
- Simulator logs live in the Logs drawer in the preview, and `serve-sim` also
  serves them at `/.sim/logs` for tools that send the session bearer token.
  Forwarding this high-volume stream to the browser console is opt in: append
  `?logs=1` to the preview URL.
- Recent simulator actions are available in the browser tools panel and `serve-sim event-log`.
- Drag and drop videos and images to add them to the simulator device. 
- Keyboard commands and hot keys are forwarded to the simulator, including CMD+SHIFT+H to go home.
- Apple Watch, iPad, and iOS support.

## Log scopes

`/logs` (or the middleware's `/.sim/logs`) keeps its all-process default.
Pass `scope=user-apps` to receive only unified-log records whose emitting
executable lives in an installed app container, including app extensions.
This includes background and subsequently installed apps, not just the foreground
app. System messages merely mentioning an app are excluded.

The filter applies to SSE, snapshots, and replay. The response header
`X-Serve-Sim-Log-Scope` acknowledges the selected scope; callers requiring app-only
logs should check it because older servers may ignore the parameter.
Replay cursors belong to a device, scope, and server lifetime. Do not reuse an
all-process cursor for a user-app stream. Each scope has a separate bounded
buffer and log-stream process, started on demand and stopped when idle.
This does not capture logs from before collection started or replace crash reports.

## Why?

Hosted simulators can be hard to test, `serve-sim` enables you to test the hosted infra locally first for faster iteration. When you're ready to host a simulator remotely, simply tunnel the served URL and users can interact with the simulator as if it were running locally on their device.

I develop the Expo framework, but this tool is completely agnostic to React Native and can be used for any iOS interaction you need.

## Install

Requires an Apple silicon (`arm64`) Mac with Xcode command line tools (`xcrun simctl`) and a [maintained Node.js LTS release](https://nodejs.org/en/about/previous-releases) (currently Node 20+). Older or end-of-life Node versions are not supported. `bun` is **not** required to run the CLI. Camera injection uses a host-side helper built for macOS 14+.

The bundled native addon, simulator tools, and host helpers are arm64-only.

The iPhone Duo simulator supports touch input, scrolling, and touch gestures on both the folded cover screen and the half-open or fully open inner screen. Frames and input follow the active display and its orientation; an app can still restrict its supported orientations.

Three shortcuts below the phone select Fully folded, Partially open, and Fully open.
At the top of Simulator settings in the Tools sidebar, the Fold pose dropdown
adds Laptop and Tent. The next rows provide a live 0–180° hinge slider with
decimal angle input and Table Mode, using the same controls as other settings.
Partially open uses Book: it and Laptop use a 90° hinge angle with different
physical orientations; Tent uses 80°.
Duo defaults to 3D using Apple's model from the host's Xcode installation,
with live displays and smooth folding, unfolding, and pose transitions.
Display pixels stay attached to their
physical panels as the model moves. Closed and Open face the viewer directly,
with the open model following the screen's portrait or landscape layout. Laptop
rests level and Tent presents the outside cover screen. The original `V68.usdz`
is loaded locally, without bundling Apple's model or downloading it. The view
respects the browser's reduced-motion preference. **Simulator → Preview mode**
switches between 2D and 3D; AX inspection also uses the flat view. See [hinge controls and display
selection](packages/serve-sim/docs/hinge-controls.md) for Device Hub's hidden
controls and the simulator APIs behind them.

## CLI

```
serve-sim [device...]                 Start preview server (default: localhost:3200)
serve-sim --no-preview [device...]    Stream in foreground without a preview server
serve-sim gesture '<json>' [-d udid]  Send a touch gesture
serve-sim button [name] [-d udid]     Send a button press (default: home)
serve-sim type <text> [-d udid]       Type text via the simulator keyboard
                                      (US keyboard only; also --stdin / --file <path>)
serve-sim rotate <orientation> [-d udid]
                                      portrait | portrait_upside_down |
                                      landscape_left | landscape_right
serve-sim hinge <fold|half|unfold|degrees> [-d udid]
                                      Set the hinge angle (0° folded, 180° unfolded)
serve-sim ca-debug <option> <on|off> [-d udid]
                                      Toggle a CoreAnimation debug flag
                                      (blended|copies|misaligned|offscreen|slow-animations)
serve-sim memory-warning [-d udid]    Simulate a memory warning
serve-sim event-log [-d udid]         Show recent simulator events

serve-sim camera <bundle-id> [-d udid] [source-options]
                                      Inject a synthetic camera feed and (re)launch the app
serve-sim camera switch <placeholder|webcam|file> [arg] [-d udid]
                                      Hot-swap the running helper's source (no relaunch)
serve-sim camera mirror <auto|on|off> [-d udid]
                                      Hot-swap preview-layer mirror mode
serve-sim camera status [-d udid]     Print helper state as JSON ({alive, source, ...})
serve-sim camera --list-webcams       List host camera devices
serve-sim camera --stop-webcam [-d udid]
                                      Stop the camera helper for a device

Options:
  -p, --port <port>   Starting port (preview default: 3200; helper default: 3100)
      --detach        Spawn server and exit (daemon mode)
  -q, --quiet         JSON-only output
      --no-preview    Skip the web UI; stream in foreground only
      --codec <codec> HTTP stream codec: 'auto', 'h264', or 'mjpeg'
      --transport <http|webrtc>
                      Stream transport (default: http)
      --webrtc-codec <vp8|vp9|h264>
                      WebRTC video codec (default: h264)
      --stun-url <url[,url...]>
                      STUN URL(s) for WebRTC ICE
      --turn-url <url[,url...]>
                      TURN URL(s) for WebRTC ICE
      --turn-username <username>
                      TURN username
      --turn-credential <credential>
                      TURN credential
      --mjpeg-fps <fps>
                      MJPEG frame rate (1-120)
      --mjpeg-quality <quality>
                      MJPEG quality (0.05-1)
      --max-dimension <pixels>
                      Maximum captured width or height; 0 keeps native resolution
      --video-bitrate <bits-per-second>
                      H.264/WebRTC target bitrate
      --video-fps <fps>
                      H.264/WebRTC frame rate (1-140)
      --launch-app-identifier <id>
                      Bundle identifier of an installed app to launch once the
                      simulator boots
      --launch-arg <arg>
                      Argument passed to the app when it launches (repeatable)
      --open-url <url>
                      URL to open in the app after it launches
      --list [device] List running streams
      --kill [device] Kill running stream(s)

Camera options (used with `serve-sim camera <bundle-id>`):
  -f, --file <path>          Image or video file (kind auto-detected from
                             extension/magic bytes; videos loop at native FPS)
      --webcam [name]        Live host webcam (defaults to the built-in
                             front camera when [name] is omitted)
      --mirror [on|off|auto] Override preview-layer mirroring (default: auto =
                             front mirrored, back not). Data-output buffers
                             are never auto-mirrored, matching AVF defaults.
      --no-mirror            Shortcut for --mirror off
      --build                Rebuild the dylib + helper from source
```

WebRTC uses HTTP for SDP signaling and RTP for video. Simulator input and screen
metadata continue over the existing helper WebSocket. ICE prefers a direct UDP
path when one is reachable, even if the page was loaded through a tunnel URL;
TURN is used as a fallback when direct/STUN candidates fail.
Starting with `--transport webrtc` locks the preview to WebRTC for the lifetime
of the server. The UI exposes only WebRTC codec and encoder controls, the
settings API rejects HTTP-only controls, and the MJPEG/AVCC endpoints return
`409 stream_transport_locked` instead of opening tunneled screen streams.
While a peer is connected, one absolute-cadence publisher continuously submits
the latest captured frame at the configured `--video-fps`. SimulatorKit change
callbacks are supplemented by a 60 Hz IOSurface seed poll; that poll is a
fallback cadence, not a capture FPS ceiling. The libwebrtc
source adapter uses a 1,000 FPS safety ceiling and the RTP sender has no separate
FPS cap, so neither can phase-collide with the publisher cadence.
Multiple WebRTC viewers can use the same simulator simultaneously. They share
one SimulatorKit capture source, while each viewer has an independent peer
connection, encoder, congestion controller, and helper WebSocket. HTTP streams
continue to support multiple viewers as well.

See [WebRTC architecture](docs/webrtc-architecture.md) for the current design,
control-channel decision, known constraints, and planned direction.

See [API](docs/api.md) for the HTTP routes, authentication, CORS and the
WebSocket endpoints.

### Examples

```sh
serve-sim                              # auto-detect booted sim, open preview
serve-sim "iPhone 16 Pro"              # target a specific device
serve-sim --detach                     # start a background helper, return JSON
serve-sim --list                       # show running streams
serve-sim --kill                       # stop all helpers

# Type text into the focused field
serve-sim type "Hello, world!"
echo "from stdin" | serve-sim type --stdin
serve-sim type --file ./snippet.txt

# Camera injection
serve-sim camera com.acme.MyApp                            # animated placeholder
serve-sim camera com.acme.MyApp --webcam                   # default webcam
serve-sim camera com.acme.MyApp --webcam "MacBook Pro Camera"
serve-sim camera com.acme.MyApp --file ~/Pictures/face.png # static image
serve-sim camera com.acme.MyApp --file ~/Movies/loop.mp4   # looping video

# Hot-swap source on a running helper (no app relaunch)
serve-sim camera switch placeholder
serve-sim camera switch webcam
serve-sim camera switch ~/Movies/loop.mp4                  # auto-detects file kind

# Other helpers
serve-sim camera mirror on
serve-sim camera status                                    # JSON: alive, source, mirror
serve-sim camera --list-webcams
serve-sim camera --stop-webcam
```

Multiple booted simulators are supported by passing several device names. With no device argument, serve-sim selects an existing stream, a booted simulator, or a default simulator to boot.

Supervisors can probe `GET /healthz` to confirm that the preview server is
listening and `GET /readyz` to wait until the selected simulator and native
capture session are ready. Both endpoints return JSON and disable caching.

### Launching an app

`--launch-app-identifier <bundle-id>` launches an app that is already installed on the
simulator, before the stream starts. Install it yourself first (`xcrun simctl install`);
`serve-sim` only launches.

```sh
serve-sim --launch-app-identifier host.exp.Exponent \
  --launch-arg -EXDevMenuIsOnboardingFinished --launch-arg 1 \
  --open-url exp://127.0.0.1:8081
```

`--launch-arg` is repeatable and maps to `simctl launch` process arguments. `--open-url`
runs `simctl openurl` after the app is up, and pre-approves custom URL schemes so the
Simulator does not ask for confirmation. This matters for `exp://` deep links on a headless host.

Launching from `serve-sim` rather than beforehand matters because a second `simctl launch`
on a running app is a no-op: it neither restarts the app nor applies new arguments. Owning
the launch is what lets `serve-sim` attach to the process from the start.

### Camera

`serve-sim camera <bundle-id>` replaces the simulator's camera feed for a single app. A small host-side helper writes BGRA frames into a POSIX shared-memory region; an injected dylib (`DYLD_INSERT_LIBRARIES`) swizzles AVFoundation inside the simulator process so the app reads from that region instead of the simulator's stub camera.

The helper is one-per-device and outlives any single app launch, so multiple apps on the same simulator can share the feed — just run `serve-sim camera <other-bundle-id>` again to relaunch the next app with the dylib attached. Source changes (`camera switch`) and mirror changes (`camera mirror`) flow through the helper's control socket and don't relaunch the app.

Sources:

- **placeholder** — animated programmatic frames (default).
- **file** — image (PNG/JPEG/HEIC/…) or video (mp4/mov/m4v/webm/…). The CLI sniffs the kind from the extension and falls back to magic bytes for files without an extension.
- **webcam** — live `AVCaptureDevice` (built-in, Continuity, external).

## Connectors

`serve-sim` can be used with dev servers, browser, and AI editors for more seamless integration.

### Agent Skill

An [Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) ships in [`skills/serve-sim`](skills/serve-sim) — it teaches AI coding agents (Claude Code, Cursor, Codex CLI, Gemini CLI, and any host implementing the open Agent Skills standard) how to drive a simulator through the CLI: taps, gestures, hardware buttons, rotation, camera injection, and handing the stream off to the host's preview pane.

```sh
bunx add-skill expo/serve-sim
```

See [`skills/serve-sim/README.md`](skills/serve-sim/README.md) for the full capability list.

### Claude Code Desktop

Create a `.claude/launch.json` and define a server:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "Apple",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["serve-sim"],
      "port": 3200
    }
  ]
}
```

### Expo

Expo apps don't need to touch `metro.config.js` — the [`expo-device-hub`](https://github.com/expo/expo-device-hub) plugin uses `serve-sim` and sets up the device streaming for you.

```sh
npx expo install expo-device-hub
```

Then run `npx expo start` and open the simulator preview at:

```
http://localhost:8081/_expo/plugins/expo-device-hub
```

No other configuration needed.

## Embed in your dev server

`@expo/serve-sim/middleware` is a **fetch-style** middleware. `simMiddleware(options)` returns a Web-standard request handler with a `.handleWebSocket` hook, so it mounts in any server that speaks `Request`/`Response` (Bun, Deno, Hono, a Node adapter, …). Run `serve-sim --detach` once to start the streaming helper, then wire the two entry points:

```ts
import { simMiddleware } from "@expo/serve-sim/middleware";

const middleware = simMiddleware({ basePath: "/.sim" });

// `server` is a stand-in for your runtime (Bun.serve, node:http + ws, Deno, …).

// HTTP — run every request through the middleware. It returns a Response for
// serve-sim's own routes (preview at /.sim, state at /.sim/api, SSE logs at
// /.sim/logs), or `undefined` — meaning "not mine", so fall through.
server.onRequest(async (request) => {
  return (await middleware(request)) ?? new Response("Not found", { status: 404 });
});

// WebSocket — the preview client runs execs, simulator settings, and the SSE
// side-channels over one socket at `<basePath>/exec-ws`, with no HTTP fallback.
// On upgrade, hand the request + accepted socket to handleWebSocket; it returns
// true once it owns the socket. `socket` is a `ws`-style WebSocket (Node's `ws`
// works as-is; other runtimes need a small adapter).
server.onUpgrade((request, socket) => {
  if (!middleware.handleWebSocket?.(request, socket)) socket.close();
});
```

The middleware reads the helper's state from `$TMPDIR/serve-sim/` and points the browser at the helper's stream, interaction WebSocket, and WebKit DevTools endpoints. By default those URLs target the helper's own port directly (the helper answers loopback origins), so a plain `app.use(...)` mount works without touching your server's WebSocket handling.

### Single-port / remote proxying

To expose the preview to remote viewers behind a single port (the way standalone `serve-sim` does), pass `proxyHelpers: true`. The browser then reaches the stream, control socket, and DevTools through same-origin `/.sim/helper/<device>` and `/.sim/devtools` URLs, so the per-device helper port and inspect-webkit bridge can stay local to the host. This routes WebSockets through the middleware, so you must forward your server's `upgrade` events to `handleUpgrade`:

```ts
const middleware = simMiddleware({ basePath: "/.sim", proxyHelpers: true });

// Route HTTP requests through `middleware(request)` as above, and also forward
// raw upgrade events for helper and DevTools proxy sockets.
const server = listen();
server.on("upgrade", (req, socket, head) => middleware.handleUpgrade(req, socket, head));
```

If you enable `proxyHelpers` but don't wire `upgrade`, the page still loads video over HTTP but loses simulator input and DevTools (their sockets never reach the proxy). When terminating TLS at a reverse proxy, forward `X-Forwarded-Proto` so the helper URLs use `https`/`wss` and avoid mixed-content blocks.

## How it works

```
┌──────────────┐   IOSurface   ┌──────────────────────┐  HTTP / WebRTC  ┌─────────┐
│ iOS Simulator│ ────────────► │ serve-sim process    │ ──────────────► │ Browser │
└──────────────┘               │ Swift N-API capture  │                 └─────────┘
                               │ + Node middleware    │
                               └──────────────────────┘
                                          ▲
                                     state files in
                                   $TMPDIR/serve-sim/
```

The npm package ships the native capture addon and LiveKit WebRTC framework alongside the Node CLI. `bun` is needed to build the package, but not to run the published CLI.

## Development

The monorepo [Release workflow](../../../../.github/workflows/release.yml) builds and tests
`@expo/serve-sim` on GitHub's `macos-15` Apple silicon runner before publishing. It checks
that the runner is `arm64` before starting the build.

```sh
bun install
bun run packages/serve-sim/build.ts                   # full production build
bash packages/serve-sim/Sources/build-test-fixtures.sh # simulator test fixtures
packages/serve-sim/Sources/SimNative/build.sh         # native addon only
bun run --filter @expo/serve-sim dev                  # watch mode
bun run --filter @expo/serve-sim tart-dev             # guest preview at localhost:3200
bun run --filter @expo/serve-sim tart-test -- <files> # bun test on the guest
```

### Tart guest

Run serve-sim **on a [tart](https://github.com/cirruslabs/tart) macOS VM** instead of the host. SSH as Unix user `expo` (not `tart exec` as admin), which matches how EAS-shaped VMs actually run.

Needs the `tart` CLI, a VM with Xcode (default name `tahoe-xcode`), and a built native addon.

```sh
bun run packages/serve-sim/build.ts
bun run --filter @expo/serve-sim tart-dev
# → Preview at http://localhost:3200
```

`tart-dev` starts the VM if needed, boots an iPhone 17, runs `bun run dev.ts` on the guest, and tunnels guest `:3200` to the host. Host port `3200` must be free. Ctrl-C stops the tunnel and the guest server.

`tart-test` uses the same guest, but runs `bun test` there. It stages package src onto the VM, boots an iPhone, and executes the files you pass over SSH as `expo`. Pass the files; with none it exits instead of running the whole guest suite.

```sh
bun run --filter @expo/serve-sim tart-test -- src/__tests__/foo.test.ts
bun run --filter @expo/serve-sim tart -- test src/__tests__/foo.test.ts
```

First run creates the `expo` user and copies bun onto the guest (`bun run --filter @expo/serve-sim tart -- setup` if you want that step alone).

The VM mounts this checkout at `/Volumes/My Shared Files/serve-sim`. If the VM was started from a different worktree, stop it and rerun from this one.

```sh
bun run --filter @expo/serve-sim tart -- ssh                 # shell as expo
```

`tart` also has `up`, `boot`, and `stage` if you need the pieces separately.

Env (all optional): `TART_VM=tahoe-xcode`, `TART_USER=expo`, `TART_SHARE_NAME=serve-sim`, `PORT=3200`.

### EAS preview of a CI package

`--package-version` pins serve-sim only on `--type web-preview-only`. The other session types use the flag for their own package (`agent-device`, `appium`, `argent`) and always run serve-sim at `latest`, so a serve-sim tarball URL breaks them.

The EAS [serve-sim tests workflow](../../../../.eas/workflows/sim-test.yml) packs
`serve-sim.tgz` for pull requests that change `packages/serve-sim` and uploads it as
`serve-sim-npm-package`. It packs before the tests run, so the tarball exists even when
they fail. Copy the download URL from the run, then pass it as `--package-version`.
Run these commands from an Expo project directory.

```sh
npx --yes eas-cli@latest workflow:runs --workflow sim-test.yml --limit 5

npx --yes eas-cli@latest workflow:view <workflow-run-id> --non-interactive --json \
  | jq -er '.jobs[].artifacts[]? | select(.name == "serve-sim-npm-package") | .downloadUrl'
```

`--non-interactive` requires the run ID as an argument. Without it, `workflow:view` prompts for a run. Without `--json`, it prints a Log URL for the run on the Expo dashboard, and each job lists its artifacts with a Download URL.

The download URL is signed and expires one hour after `workflow:view` returns it. The worker installs the package minutes after the session starts, so copy a fresh URL for each session. An expired URL fails in the job log, not in your terminal. The URL also appears in that log, so anyone who can read the run can download the artifact until the URL expires.

```sh
npx --yes eas-cli@latest simulator:start --platform ios --type web-preview-only --non-interactive \
  --name "serve-sim preview" \
  --package-version '<download-url>'
```

EAS runs `npx @expo/serve-sim@<value>`, so the flag takes any npm spec: a version, a tag, or a tarball URL. Quote the URL.

Install and launch an app at start with one of `--build-id`, `--application-archive-url`, or `--expo-go`. `--launch-arg` and `--open-url` need one of those. `--sdk-version` needs `--expo-go`.

```sh
npx --yes eas-cli@latest simulator:start --platform ios --type web-preview-only --non-interactive \
  --name "serve-sim preview" \
  --package-version '<download-url>' \
  --expo-go
```

EAS installs and launches the app before serve-sim starts. After the preview is up, drop an `.ipa` on the page to install another app. The page takes an `.ipa` or media, not an `.app` bundle or a build archive, so pass `--build-id` or `--application-archive-url` for those. Stop with `npx --yes eas-cli@latest simulator:stop`.

## Origin and attribution

`serve-sim` was created and open-sourced by [Evan Bacon](https://github.com/EvanBacon) in the [original serve-sim project](https://github.com/EvanBacon/serve-sim). This repository is an Expo-maintained fork. We are grateful to Evan for creating the project and making it available to the community.

See [NOTICE](NOTICE) for attribution details.

## License

Apache-2.0
