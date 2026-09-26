# continue.md: handoff for the next agent

_Last updated: 2026-09-26. The simstream repo is merged into this branch; see "Picking this up" below._ The integration is built, smoke-tested and committed locally (`aa32ccd`). The benchmark matrix is running._

## Current task (from the user)
> Fork the canonical serve-sim, integrate our video stack, and run a side-by-side comparison. Record
> videos of the same scripts side by side. Keep this continue.md up to date.

## Picking this up on another machine

Everything is on branch `simstream-video` of this repo. The simstream engine repo, with its 26-commit
history, is merged in as a subtree at `packages/serve-sim/packages/serve-sim/engine/simstream/`: engine
sources, `bench/` (measurement, recording and report tools), and `deploy/` (Caddy, DDNS, launchd).

```sh
git fetch <remote> simstream-video && git checkout simstream-video
bun install                                   # at the repo root
cd packages/serve-sim/packages/serve-sim
# The native addon's source build hangs downloading LiveKit's xcframework, so reuse a published one:
npx -y @expo/serve-sim@0.3.4 --help >/dev/null  # populates the npx cache
SERVE_SIM_PREBUILT_NATIVE=$(dirname $(dirname $(find ~/.npm/_npx -path '*@expo/serve-sim/dist/native' -type d | head -1)))/dist bun run build
node dist/serve-sim.js --transport http --codec simstream -p 3200   # needs a booted simulator
```

- Engine alone: `cd engine/simstream && ./run.sh` (standalone viewer on :8765). The engine needs Xcode
  (SimulatorKit/CoreSimulator private frameworks).
- The bench scripts still carry absolute paths from the original machine (`~/Development/simstream`,
  `/tmp/fbench`, host names). Adjust them before rerunning.
- Pulling future engine changes from a standalone simstream clone:
  `git merge -s subtree -Xsubtree=packages/serve-sim/packages/serve-sim/engine/simstream <simstream>/main`.

## Plan and status: DONE (2026-09-25 15:12)
- **Fork:** `~/Development/expo-device-hub-simstream`, branch `simstream-video`, local only.
  - `aa32ccd`: `--codec simstream` (our engine plus serve-sim's UI and input).
  - `6512155`: an upstream serve-sim bug fix. The synchronous `ps` in `/grid/api/memory` stalled Node
    ~75 ms every 5 s, freezing every proxied stream.
  - **Not pushed.** `gh` is logged in as `dougbot-agent`; ask the user which account should own a
    GitHub fork or PR.
- **Build:** `bun install` at the root, then in `packages/serve-sim/packages/serve-sim` run
  `SERVE_SIM_PREBUILT_NATIVE=/Users/sethwebster/.npm/_npx/76a4f551f1bf97d9/node_modules/@expo/serve-sim/dist bun run build`.
  That reuses the published 0.3.4 native addon; the LiveKit download hangs otherwise. Step 9 builds
  the engine.
- **Run:** `node dist/serve-sim.js --transport http --codec simstream -p 3200`.
- **Results after the fix** (the fork, 4 interleaved reps per mode, arrival age, 20 s runs):

  | Scene | serve-sim + simstream | stock WebRTC | stock HTTP/AVCC |
  |---|---|---|---|
  | Light | 37.6 ms, 59.9 fps, 0.2% skipped, 0 freezes | 36.0 ms, 50.6 fps, 18.6% skipped, 12 freezes | 273 ms, 54 fps |
  | Heavy | 41.6 ms, 59.8 fps, 0.2% skipped, 0 freezes | 38.8 ms, 48 fps, 26% skipped, 8 freezes | 283 ms, 53 fps |
  | Resolution | 1206×2622 | 640×1392 (upstream caps H.264 over WebRTC; "stalls" at full) | 1206×2622 |

  - The heavy reps 3–4 ran with load around 70 (Docker).
  - The JSONL files are in `~/Development/simstream/bench/results/fork-2026-09-25-*.jsonl`.
- **Videos** (on the M4's and the M5's `~/Desktop`):
  - `serve-sim-vs-simstream-route.mp4`: 42 s, the same route in all 3 modes.
  - `serve-sim-vs-simstream-latency.mp4`: 17 s, the heavy clock scene with live "shown N ms old" and
    fps captions.
  - Both are 2412×1844 at 60 fps. Raw recordings are in `/tmp/fbench/rec/`.
- **Synced route video** (`serve-sim-vs-simstream-route-synced.mp4`, 39 s, on both Desktops): the user
  said the first route video drifted out of sync. The cause was the harness (sleep after each awaited
  CDP input, so the drift depended on page load), not the protocols. Now inputs run on an absolute
  schedule, and the page marks each pointerdown's frame. `bench/compose-aligned.py OUT base...` aligns
  every input across panes. Measured input spacing is identical across modes to ±1 frame.
- **Touches video** (`serve-sim-vs-simstream-route-touches.mp4`, 39 s): the synced route with a finger dot
  drawn at each input's position and send time, on all panes. Made with `python3 bench/compose-aligned.py
  --touches OUT.mp4 /tmp/fbench/rec/route-{S,W,H}`. Verified frame by frame (the first tap's dot is on
  frames 60–75).
  - **Copying it to the M5 is slow:** the user is on spotty airplane wifi, about 30 KB/s. Use
    `rsync --partial --inplace` with retries (it resumes). The user asked to keep trying.
- **Over-the-network video** (`~/simstream-videos/serve-sim-vs-simstream-route-network.mp4`, plus a 3.5 MB
  `-small` version):
  - The fork runs on the **Mac Mini** (copied to `~/simfork`: `dist` + `node_modules/ws`), bound to its
    Tailscale IP, on iPhone 17 Pro Max `B3AFC702…` (iOS 26.5, dark mode).
  - The viewer/recorder runs on the off-prem **Expo laptop** (`seth@sethwebster-expo.$SIMSTREAM_TAILNET`,
    node at `~/.local/share/mise/installs/node/22.20.0/bin/node`, tools in `~/simbench`). The path to the
    Mini is direct, ~13 ms.
  - Script: `bench/rec-remote-mini.sh`; route: `bench/route-mini.json`; compose with
    `ROUTE=route-mini.json python3 bench/compose-aligned.py --touches OUT /tmp/fbench/remote-mini/mini-{S,W,H}`.
  - **The laptop sleeps on idle** (a brief DarkWake on network traffic, then sleep ~45 s later). At the
    user's request, it's now kept awake permanently by a LaunchAgent,
    `~/Library/LaunchAgents/com.seth.caffeinate.plist` (`caffeinate -dimsu`, KeepAlive). Undo it with
    `launchctl bootout gui/$(id -u)/com.seth.caffeinate && rm ~/Library/LaunchAgents/com.seth.caffeinate.plist`.
  - The Pro Max sim was shut down afterwards. The user's :8775 simstream and the 17 Pro on the Mini
    weren't touched.
  - The M4 is too busy (load 30–40, Docker) for clean runs; that's why the Mini was used (user approved).
- **`simstream.sethwebster.com` is a direct public route to the Mac Mini** (set up 2026-09-26; the
  Cloudflare tunnel is no longer used):
  - **DNS:** an unproxied A record pointing at the home IP (`$SIMSTREAM_HOME_IP` at setup). The Mini's
    `com.sethwebster.simstream-ddns` agent runs `~/simstream-live/deploy/cloudflare-ddns.sh` every 5 min,
    using the zone token in `~/.config/simstream/cloudflare-token`, which came from the cloudflared
    `cert.pem`.
  - **Router (Verizon Fios, $SIMSTREAM_ROUTER_ADMIN):** port forwards `simstream-https` WAN 443 → $SIMSTREAM_MINI_LAN_IP:8443
    and `simstream-http` WAN 80 → $SIMSTREAM_MINI_LAN_IP:80. The Mini's DHCP lease (MAC $SIMSTREAM_MINI_MAC, host
    "seth-agent") is Static.
  - **Caddy:** `com.sethwebster.simstream-caddy` serves HTTPS on 8443, because Tailscale serve holds *:443
    and macOS won't let a non-root process bind a low port on a specific IP. :80 handles redirects and
    HTTP-01. The certificate is Let's Encrypt.
  - **What's served (since 2026-09-26 00:15): the serve-sim fork** in simstream mode.
    `com.sethwebster.serve-sim-fork` runs `~/simfork/dist/serve-sim.js --transport http --codec simstream
    --require-token` on 127.0.0.1:3200 for iPhone 17 Pro Max `B3AFC702…`. Caddy proxies to it.
    - **Token-gated,** because serve-sim's typed host actions can stop the server, install apps, read
      simulator data containers, and use the webcam. The token is pinned via `SERVE_SIM_TOKEN` (fork
      commit `82c35e2`) from `~/.config/simstream/serve-sim-token` on the Mini. The user's link is in
      `~/Desktop/simstream-link.txt` on the M5 (mode 600).
    - **Never print the token.** It was rotated once after it leaked into tool output.
    - To update the fork: rebuild on the M4, then
      `rsync -a --delete dist/ seths-mac-mini:simfork/dist/` and
      `launchctl kickstart -k gui/$(id -u)/com.sethwebster.serve-sim-fork`.
    - The standalone simstream agent (`com.sethwebster.simstream-live`, :8766) is retired; its plist is in
      `~/simstream-live/deploy/` for rollback. The user's pre-RTT instance on :8775 is untouched.
  - Logs are in `~/Library/Logs/{serve-sim-fork,simstream-caddy,simstream-ddns}.log`. Deploy files are in
    `~/Development/simstream/deploy/`.
- **iPad link (tailnet only):** https://seth-webster-m4.$SIMSTREAM_TAILNET:8450/ serves `~/simstream-videos`
  (`npx http-server` on 127.0.0.1:8460, which supports byte ranges; `tailscale serve --https=8450`). Remove it
  with `tailscale serve --https=8450 off` and kill :8460.
- **Machine restored:** live simstream on :8765 (Tailscale and Cloudflare both answer 200). :3200 and
  :8799 are stopped.
- **Bench tools are committed** in `~/Development/simstream` (`bench/runfork.sh`, `matrix-fork.sh`,
  `record-fork.mjs`, `route-fork.json`, `rec-fork-all.sh`, `compose-fork.sh`, `lag-preload.mjs`).
  - To re-record: start the bench server
    (`cd ~/Development/simstream/bench && /usr/bin/python3 -m http.server 8799 --bind 127.0.0.1 &`), stop
    :8765, then run `./rec-fork-all.sh route` and `./compose-fork.sh route OUT.mp4
    /tmp/fbench/rec/route-{S,W,H}`.
  - Calendar must be in year view before the route runs.

## Key locations
- **simstream (our stack):** `~/Development/simstream`, a Swift package. Commits go through `808f124`.
  - Build/run: `./run.sh [--port N]`. It signs with the user's Developer ID so the macOS firewall allows LAN.
  - Main files: `Sources/SimBridge` (private CoreSimulator/SimulatorKit wrapper), `FramePump.swift`,
    `Encoder.swift`, `Viewer.swift` (per-viewer encoder and CongestionController), `Server.swift`,
    `Web/index.html`.
  - **Frame header** (49 bytes, little endian): `u8 flags | u32 seq | f64 capture | f64 encodeStart |
    f64 encoded | f64 sent | u32 inputSeq | f64 inputReceived`, all on the server clock in ms.
  - **Client → server messages** (JSON over WebSocket `/stream`): `hello{codecs}`,
    `settings{transitions,hevc}`, `ack{seq}`, `ping{ts}`, `touch{p,x,y,seq,edge}`, `key`, `button`,
    `pause`/`resume`, `keyframe`.
- **Benchmark harness:** `~/Development/simstream/bench/`, copied from `/tmp/bench`.
  - `clock.html`: the barcode clock page to open in the simulator. Serve it with
    `cd bench && /usr/bin/python3 -m http.server 8799 --bind 127.0.0.1`, then
    `xcrun simctl openurl booted http://127.0.0.1:8799/clock.html[#heavy]`.
  - `measure.mjs`: headless Chrome through CDP. It decodes the barcode from whatever the page shows
    (video, canvas or img) and reports arrival age from a 4 ms poll (phase-free), frames shown, skipped
    share and freezes.
  - `run1.sh A|B|C|D light|heavy rep`: starts one server, measures, and stops it. **It still points at
    `/tmp/bench` paths; update it if `/tmp` has been wiped.**
  - `results-2026-09-25-local.jsonl`: stock serve-sim 0.3.4 against simstream (summary below).
  - Other tools: `throttle.mjs` (link emulator: `listen target mbps delayMs jitterMs stallEveryMs
    stallMs`), `latency.mjs` (HUD waterfall), `flicks.mjs`, `transitions.mjs`, `grab.mjs`/`record4.mjs`
    (save the received H.264 stream), `dryrun.mjs` + `demo-steps.json` (the scripted demo route).
- **serve-sim code:** `packages/serve-sim/packages/serve-sim/`.
  - Swift addon: `Sources/SimNative`, including `WebRTCPublisher`, `CaptureEngine`, `FrameCapture`,
    `H264Encoder`.
  - TS server: `src/`, including `device-session.ts`, `index.ts` and `middleware.ts`.
  - Client: `src/client`, including `simulator/SimulatorView.tsx`, `use-avcc-stream.ts` and
    `hooks/use-webrtc-stream.ts`.
  - Docs: `docs/webrtc-architecture.md`.

## Machine state (M4 Max, "seth-webster-m4", NYC area)
- **Live simstream** on :8765, running build `808f124` (restored after testing). The restart command is
  `cd ~/Development/simstream && nohup ./run.sh > ~/Library/Logs/simstream.log 2>&1 &`. Also stop the
  bench python server on :8799 and anything on :3200 when done.
  - Tailscale: `https://seth-webster-m4.$SIMSTREAM_TAILNET:8449`.
  - Public Cloudflare tunnel `simstream` → `https://simstream.sethwebster.com`. The cloudflared config is
    `~/.cloudflared/simstream.yml` on the M4.
- **The Mac Mini** (`seths-mac-mini`, ssh) runs simstream `a740a40` (pre-RTT build, for the user's
  recording) on :8775. Tailscale: `https://seths-mac-mini.$SIMSTREAM_TAILNET:8457`. Don't touch it
  unless asked.
- **Simulator:** iPhone 16 Pro, iOS 18.6, UDID `68F56774-48BD-4197-8ABE-961F954292DD`, booted.
- **T3 Code** runs its own bundled expo-device-hub/serve-sim helper, pid 17591 at last check. serve-sim
  instances share `$TMPDIR/serve-sim` state and will kill "stale" helpers bound to non-booted devices.
- **Background load** is ~10–12 on 16 cores (T3 Code ~90%, Docker VM ~60%). Interleave benchmark
  runs to cancel drift.

## Findings so far (the user has seen these)
Stock serve-sim 0.3.4 against simstream, local, 20 s runs, arrival age (lower is better):

| Scene | simstream | serve-sim WebRTC | serve-sim HTTP/AVCC |
|---|---|---|---|
| Light | 39 ms, 60.0 fps shown, 0% skipped | 44 ms, 50.7 fps, 18% skipped | 283 ms (a 16-frame native queue sitting full) |
| Heavy | 39 ms | 37.5 ms, but WebRTC downscaled itself to 804×1748 | 287 ms |

- serve-sim WebRTC skips ~18% of frames because its ContinuousFramePacer drifts against the
  simulator's render clock. simstream's render-locked capture avoids this.
- Other serve-sim issues found:
  - The WebRTC minimum bitrate is pinned at 90% of target.
  - `PrioritizeEncodingSpeedOverQuality` is rejected under low-latency rate control, so it's a no-op.
  - H.264 over WebRTC is capped at 1280 by a "TEMPORARY GUARD", although the published 0.3.4 ran at
    full resolution.
  - There's no tap-to-pixel measurement.

## Gotchas learned the hard way
- **zsh:** never name a loop variable `path`, since it clobbers `PATH`.
- **Don't `pkill -f "release/simstream$"` inside a multi-line command.** It can match the shell running
  it. Kill by port instead: `kill $(lsof -tiTCP:PORT -sTCP:LISTEN)`.
- **Long single Bash commands (over ~3–4 min) get killed with exit 137.** Split them into batches.
- **WebCodecs needs a secure context:** `https://` or `localhost`.
- **Stale browser tabs running old page code show up as unresponsive viewers.** simstream probes them
  with a keyframe every 10 s.
- **Headless Chrome samples at its own refresh rate,** so refresh-sampled latency has a random
  0–17 ms offset per run. Use the arrival-age metric.
- **The user wants:** full resolution (no downscaling), 60 fps, sharp output, and videos of results.
  Keep answers direct.
