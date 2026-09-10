# Android hardware encoding validation

Verified 2026-09-10 on Apple M4 Pro, macOS 26.6.2, Homebrew ffmpeg 9.0.1,
Android emulator `Codex_Medium_Phone_540x1170_API_36_1` (Android 16), and the
Codex in-app browser. The emulator was already running; boot and GPU flags were
not changed. Linux NVENC and VAAPI devices were not available for live testing.

## Build and server evidence

Built the workspace and ran the actual Node CLI:

```sh
bun run build
node packages/expo-device-hub/dist/server/cli.mjs --platform android --encoder hardware
```

The Codex browser displayed the emulator live, with Hardware selected and
`Active encoder: h264_videotoolbox` in Stream options. The device-scoped
`/vendor/serve-emu/api/stream-mode` endpoint returned:

```json
{
  "mode": "grpc-screenshot",
  "grpcImageMode": "mmap",
  "encoder": "hardware",
  "encoderName": "h264_videotoolbox",
  "availableEncoders": ["software", "hardware"],
  "inputSource": "scrcpy"
}
```

Both `/health` and `/api` reported the actual encoder. The running ffmpeg process
used `-c:v h264_videotoolbox -allow_sw 0 -realtime 1 -flags +low_delay`, with
`-bf 0` and `-bsf:v h264_metadata=aud=insert`. Selecting Software changed the
reported encoder and process to `libx264`; selecting Hardware restored
VideoToolbox. No browser console errors occurred during these checks.

## Matched motion windows

Serve `docs/fixtures/hardware-encoding-animation.html` from a local HTTP server,
then open it in Android Chrome using `http://10.0.2.2:<port>/hardware-encoding-animation.html`.
The fixture continuously rotates a solid shape over a striped background.

Both windows used MMAP, WebSocket, 540×1170 frames, the existing 1280 maximum
edge setting, 30 FPS cap, and 8,000,000 bits/sec. Each window lasted about 15.6
seconds with one Codex browser viewer. CPU is accumulated process CPU-time
change divided by wall time, so one fully occupied core is 100%.

| Measurement | Software (libx264) | Hardware (VideoToolbox) |
| --- | ---: | ---: |
| Window | 15.569 s | 15.620 s |
| Emulator CPU | 384.86% | 382.26% |
| Hub/server CPU | 16.70% | 16.39% |
| ffmpeg CPU | 12.14% | 5.51% |
| Mean `/health` source FPS | 23.45 | 23.18 |
| Output frames in window | 364 | 358 |
| Server dropped-frame delta | 0 | 0 |

This fixture and host show lower ffmpeg CPU with comparable source throughput.
These short windows are not a general throughput benchmark or end-to-end
latency measurement; the source was below its configured cap in both cases.

## Recovery and strict failures

- PNG, MMAP and RGB888 were each selected in the Codex browser; all resumed
  live hardware video and retained the VideoToolbox encoder selection.

- Software → Hardware on WebSocket: approximately 1,980 ms from selecting the
  option until the UI published the backend after visible playback resumed.
- Hardware browser refresh: approximately 1,170 ms to Live.
- A second browser tab joining the active hardware stream: approximately
  2,207 ms to Live with the moving fixture visible, exercising keyframe recovery.
- Rotation restarted the hardware encoder and continued decoding. Software also
  displayed the rotated source. The existing gRPC rotation/viewport behavior
  keeps a portrait-shaped stream; the existing Rotate button derives the next
  orientation from that shape, so restoring portrait used the orientation API.
  This behavior is shared by both encoders and is outside this change.
- A second test server ran with `SERVE_EMU_HARDWARE_ENCODER=nvenc`, software
  selected, and port 3402. Selecting Hardware in its Codex browser returned 503
  with `h264_nvenc: encoder is not included in this ffmpeg build`. The UI showed
  the reason, disabled Hardware, and kept Software selected. The backend stayed
  `libx264` with session generation 0 and continued streaming.
- A third server used `--encoder hardware --transport webrtc --port 3403`.
  The Codex browser showed Hardware / VideoToolbox / WebRTC and the moving
  fixture. A five-second browser video-quality window counted 118 frames and
  two browser drops, with 540×1170 video playing and no console errors. Switching
  this viewer to Software resumed visible playback in approximately 1,685 ms.

Temporary test servers were stopped, orientation was restored to portrait, and
the emulator was returned to Home. The main hardware server and its Codex browser
view remain available for inspection.

## Automated validation

- Frozen dependency installation, monorepo lint, builds and typechecks passed.
- Full monorepo tests passed; serve-emu had 962 tests and the hub packages had
  397 tests at initial validation.
- serve-emu critical coverage, documentation sync/check and package smoke passed.
- All three stacked PRs passed their Ubuntu GitHub CI checks.
- A fresh reviewer found the original 128×128 probe was too narrow for newer
  NVENC GPUs. The probe and real hardware fixture were increased to 256×256,
  and a regression checks the actual NVENC dimensions and RGB byte count.
  The updated encoder suite passes all 40 tests, including real VideoToolbox.
- Encoder-specific bitstream, low-delay and startup measurements are recorded in
  [the encoder spike](../packages/serve-emu/packages/serve-emu/docs/hardware-encoder-spike.md).

— Codex (GPT-6)
