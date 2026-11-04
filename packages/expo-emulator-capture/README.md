# expo-emulator-capture

Experimental Android Emulator screen capture for **macOS on Apple silicon** (M1, M2,
M3, M4 and later). It copies each displayed frame on the GPU when the emulator renders
with the host GPU, and encodes it with the VideoToolbox hardware H.264 encoder.
[Expo Device Hub](../expo-device-hub) can stream an emulator through it instead of
through scrcpy.

The package is private and is not a Hub dependency. Build it from a checkout.
The design is in [LLP 0017](../../llp/0017-emulator-capture-macos.explainer.md).

## How it works

```text
Emulator display post → GL texture → GPU copy into an IOSurface
  → VideoToolbox scale and NV12 conversion → hardware H.264 → Unix socket
  → serve-emu → Device Hub (WebCodecs or WebRTC)
```

- A small agent library is preloaded into the emulator's QEMU process with
  `DYLD_INSERT_LIBRARIES`. It hooks the renderer's display post with Frida Gum.
  The emulator itself is not modified.
- With `-gpu host`, the renderer's frames are OpenGL textures. The agent copies each
  frame into an IOSurface on the GPU; the CPU never touches the pixels.
- With a software renderer (`-gpu auto` on a headless Mac picks SwANGLE), the agent
  reads the pixels back instead. Encoding still uses the hardware encoder.
- A consumer connects to the agent's socket, sets the stream size, frame rate and bit
  rate, and receives H.264. Consumers can disconnect and reconnect at any time.
- When a foldable folds or unfolds, the display size changes. The agent reconfigures
  the encoder and tells the consumer the new size.

## Build and test

Run from this package directory on macOS with Apple silicon. You need Xcode command
line tools and Bun. The build downloads the pinned Frida Gum devkit and checks its
SHA-256 digest.

```sh
bun run build   # dist/darwin-arm64/libexpo_emulator_capture.dylib
bun run test    # protocol unit tests (C++ and JavaScript)
```

On other hosts the build scripts print a warning and produce no binary.

## Use with Expo Device Hub

Set `EXPO_DEVICE_HUB_EXPERIMENTAL_EMULATOR_CAPTURE` to the absolute path of the built
library when you start the Hub:

```sh
EXPO_DEVICE_HUB_EXPERIMENTAL_EMULATOR_CAPTURE="$PWD/dist/darwin-arm64/libexpo_emulator_capture.dylib" \
  npx expo-device-hub
```

With this variable set, the Hub:

- boots emulators with the agent and with `-gpu host`,
- streams each emulator that has an agent socket through the agent, with scrcpy as the
  input transport,
- uses `scrcpy` as the default Android stream source, because the agent replaces only
  scrcpy video. `--stream-source` still overrides it.

Emulators that run without the agent stream through scrcpy as before. `/health` on the
serve-emu routes reports `captureBackend: "expo-emulator-capture"` and the capture
diagnostics (`framePath`, encoder, native and stream size, resizes).

## Standalone use

Start an emulator with the agent. Pass `-port` (or `--socket`) so the socket path is
known:

```sh
node src/cli.mjs launch -- -avd Pixel_9_Pro_Fold -no-window -gpu host -port 5554
```

Record its stream to an H.264 file:

```sh
node src/cli.mjs record --socket "$(node src/cli.mjs socket-path --port 5554)" \
  --output /tmp/capture.h264 --seconds 10 --fps 60 --max-size 1280
```

Set `EXPO_EMULATOR_CAPTURE_LOG=/path/to/file` to write the agent's log to a file. It
logs to the emulator's standard error otherwise.

Do not start the emulator through a shell script or `nohup`: macOS removes `DYLD_*`
variables when a protected system binary runs, and the agent does not load.

## Measurements

Mac mini M2 (8 GB), Android Emulator 37.2.7, Android 17 (API 37) Google APIs image,
CSS animation in Chrome, 2026-11-04:

| Renderer    | Stream              | Frames                    | Render thread per frame | Notes                                     |
| ----------- | ------------------- | ------------------------- | ----------------------- | ----------------------------------------- |
| `-gpu host` | 1080×2424 at 60 FPS | 59–60 FPS in 10 s windows | 0.11 ms                 | GPU frame path, hardware encoder          |
| `-gpu host` | 570×1280 at 60 FPS  | 59.3 FPS                  | 0.12 ms                 | Scaled by VideoToolbox                    |
| `-gpu auto` | 1080×2424 at 60 FPS | 30–34 FPS                 | 25 ms                   | Software renderer; CPU readback limits it |

At 1080×2424 and 60 FPS, the emulator process used about 8% more CPU while streaming
than without a consumer, measured per thread in the same time window. The emulator's own
CPU use changes by tens of percent over minutes, so treat this as approximate.

## Limitations

- Tested only with Android Emulator 37.2.7 (build 16195039). The agent uses private
  renderer symbols; it refuses to capture when they are missing.
- The agent loads only when the emulator starts with it. Attaching to an emulator that is
  already running is not implemented.
- Rotation is not handled. The stream shows the display in its panel orientation, and
  touches map to that orientation.
- Only the main display is captured. One consumer at a time; a new one replaces the old.

## Licenses

Original Expo code is [MIT-licensed](LICENSE). The agent includes components under
separate licenses; see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
