# simstream

Spike: stream an iOS Simulator to a browser using the ideas behind Google Stadia. The simulator
renders on the server, a hardware encoder tuned for low latency compresses the frames, the browser
decodes and draws them right away, and input goes straight back to the server.

```
 iOS Simulator (headless ok)                          Browser
 ┌──────────────────────────┐                ┌──────────────────────────┐
 │ framebuffer IOSurface ───┼─ damage cb ──► │                          │
 │   (CoreSimulator, BGRA)  │  FramePump     │                          │
 │                          │  VTPixelTransfer → NV12, scaled           │
 │                          │  VTCompressionSession (H.264, low-latency)│
 │                          │  ── WebSocket (TCP_NODELAY) ─────────────►│ WebCodecs VideoDecoder
 │                          │                │   optimizeForLatency     │ → canvas, no jitter buffer
 │ Indigo HID (touch/keys/  │ ◄── JSON ──────┤ pointer / key / button   │
 │  buttons, SimulatorKit)  │                │ acks, pings              │
 └──────────────────────────┘                └──────────────────────────┘
```

## Run

```sh
xcrun simctl boot "iPhone 16 Pro"   # any booted device works; Simulator.app is optional
./run.sh                             # build (release), sign, run; flags: --udid, --port 8765, --scale 1, --fps 60, --bitrate 40, --vfr, --refine 12, --quality
open http://localhost:8765           # Chrome/Edge/Safari 17+
```

The page and the stream share one port (WebSocket on `/stream`).

### From another device (iPhone, iPad, another Mac)

WebCodecs is only exposed in secure contexts, so any address other than `localhost` must be HTTPS.
Plain `http://<lan-ip>:8765` loads, but the page reports it can't decode. The easiest route to
trusted HTTPS is Tailscale Serve, which is visible only inside your tailnet:

```sh
tailscale serve --bg --https=8449 http://127.0.0.1:8765   # pick a port simstream isn't using
open https://<machine>.<tailnet>.ts.net:8449
tailscale serve --https=8449 off                          # to remove
```

Use `run.sh` rather than a bare `swift build`. SwiftPM output is ad-hoc signed, and the macOS
firewall silently drops non-loopback connections to it, so the result is "can't connect to the
server". `run.sh` signs the binary with your Developer ID or Apple Development identity, which the
firewall allows automatically.

## How the Stadia ideas map

| Stadia | simstream |
|---|---|
| Render in the data center, next to the encoder | Frames come directly from the simulator's framebuffer IOSurface (zero-copy wrap, GPU color convert/scale) |
| Hardware encode with low-latency tuning | VideoToolbox `EnableLowLatencyRateControl`, `RealTime`, no frame reordering (no B-frames) |
| The renderer pushes each frame to the encoder | Capture is render-locked: the simulator's per-frame damage callback triggers each capture, so the stream follows the guest's own 60 Hz clock. The timer only fills gaps |
| Constant frame rate | While someone is watching, the last frame repeats at a steady 60 fps (about 0.15 Mbps and 3.5% CPU when static), so presentation cadence stays even and still images keep sharpening. `--vfr` encodes changes only. Nothing is encoded with no viewers |
| Recover on demand | Keyframes are sent on join, on decoder error, or after a drop instead of on a fixed GOP |
| Controller talks to the server, not the client device | Input goes straight upstream as normalized touch points, is injected as Indigo HID events, and needs no window focus or cursor |
| Edge gestures | A drag that starts within a few percent of a screen edge, or out on the bezel, carries SimulatorKit's edge value on every event (1 top, 2 left, 3 bottom, 4 right; bottom and left verified), so swiping up for home or the app switcher, going back from the left, and Notification/Control Center all work |
| One encoder per session | Frames are captured once and encoded once per viewer, so each viewer gets the bitrate its own link can carry, and one viewer's keyframes never cost the others |
| Keep frame rate; let quality give | A per-viewer delay-based controller, as in WebRTC. Clients ack each decoded frame, and queueing delay above that viewer's baseline is the congestion signal. On overuse, the bitrate drops to about 85% of the measured delivery rate. It probes back up (+8% per 200 ms) only while the link is in use, and local viewers start at the maximum. Dropping frames and resyncing on a keyframe happens only past a 400 ms backlog |
| Constant-rate encoding converges | Constant frame rate does this automatically. With `--vfr`, 12 extra frames of the settled image are encoded after motion stops so it still sharpens ("refinement") |
| Don't stream to nobody | Hidden tabs send `pause` and resume with a keyframe, so a throttled background tab isn't mistaken for congestion |
| Latency telemetry | HUD shows fps in motion (idle gaps excluded), frame pacing (mean ± sd), encode, network, decode, capture→draw (NTP-style clock sync), and touch→first changed pixel. The server logs source frames captured vs missed |

## Measured (M4 Max, localhost, iPhone 16 Pro)

| | native 1206×2622 (default) | `--scale 0.75` |
|---|---|---|
| capture→draw | ≈ 11 ms | ≈ 8 ms |
| encode | ≈ 10.7 ms | ≈ 6.3 ms |
| bitrate while scrolling | 6–11 Mbps (40 Mbps cap mostly unused) | 8–12 Mbps |
| luma PSNR while scrolling (`--quality`) | ≈ 41 dB | ≈ 40.6 dB |

- With a continuous 60 fps source (a rAF page in the simulator's Safari): 60 fps delivered, 0 source frames
  missed, pacing 16.7 ms ±0.3. Touch→first changed pixel is about 15–60 ms, mostly iOS's own reaction time.
- At a 1 Mbps floor, mid-scroll PSNR drops to 31–35 dB, with smeared text and lost hairlines. Earlier
  builds spiralled down to that floor whenever any viewer fell behind. Delay-based per-viewer congestion
  control fixes this.
- `--quality` values are best compared between runs. Even at QP ≤ 12 the probe reads about 41 dB, so
  treat that as the probe's ceiling, not the encoder's.
- The low-latency rate control is required: standard VideoToolbox rate control pipelines frames, which
  showed up as about 2 s of touch latency and congestion.
- Constrained link: a dense "year view" zoom (worst case for the encoder), streamed through a 10 Mbps /
  76 ms RTT emulated link with a healthy local viewer also connected. The old shared encoder gave
  14–21 fps at 340–400 ms capture→draw. Per-viewer control gives 60 fps at about 50 ms (mostly link
  delay), with the remote viewer at 6–12 Mbps and the local one at 40 Mbps.

## Layout

- `Sources/SimBridge`: Objective-C wrapper around the private APIs. It covers device lookup, the
  framebuffer surface and damage callbacks, and `IndigoHIDMessageFor{MouseNSEvent,Button,KeyboardArbitrary}`
  sent through `SimDeviceLegacyHIDClient`. The function signatures were checked against the Xcode 27 SimulatorKit disassembly.
- `Sources/simstream/FramePump.swift`: capture pacing, IOSurface seed check, idle refinement, scale/convert.
- `Sources/simstream/Encoder.swift`: VideoToolbox H.264 and avcC → WebCodecs config.
- `Sources/simstream/QualityProbe.swift`: optional decode-back PSNR, run with `--quality`.
- `Sources/simstream/Server.swift`: HTTP and WebSocket on one port (transport only).
- `Sources/simstream/Viewer.swift`: per-viewer encoder, ack tracking, and `CongestionController`.
- `Sources/simstream/Web/index.html`: the client (decoder, input, HUD).

## Known gaps / next steps

- **Transport**: TCP WebSocket (a minimal RFC 6455 implementation sharing the HTTP port) has head-of-line blocking. Moving to WebRTC (what Stadia used) or
  WebTransport datagrams would be the real latency win on lossy networks.
- **Multi-touch**: `IndigoHIDMessageForMouseNSEvent` accepts a second point, so pinch just needs
  wiring. SimulatorKit also throttles drag events to about 60 Hz.
- **Encoder**: HEVC/AV1 for bandwidth, and reference-frame invalidation instead of a full keyframe
  after a resync. Adaptive resolution (Stadia dropped resolution before frame rate) would keep dense
  text legible at low bitrates. Each viewer costs one hardware encode session.
- **Chroma**: 4:2:0 softens colored text slightly. HEVC 4:4:4 would fix it where decoders support it.
- **Audio**: not streamed.
- **Keyboard / Lock / Siri**: wired up but only Home, tap and drag were verified. Keyboard needs a text field focused in the guest.
- **Private APIs**: these can change between Xcode releases. Pin to the known-good Xcode and smoke-test on upgrade.
- **Fleet**: one process per simulator. A broker that boots/clones devices and hands out sessions
  would turn this into the "device farm" version.
