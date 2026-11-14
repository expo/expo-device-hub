# expo-emulator-capture

Experimental Android Emulator screen capture for **macOS on Apple silicon** (M1, M2,
M3, M4 and later) and **Linux x86-64**.

- On macOS, it copies each displayed frame on the GPU when the emulator renders with the
  host GPU, and encodes it to H.264 with VideoToolbox, on the hardware encoder when the
  Mac has one.
- On Linux, it reads each frame back from the emulator's renderer and encodes it with the
  system's x264 library, build 165.

[Expo Device Hub](../expo-device-hub) streams emulators through it when you turn on its
experimental emulator capture.

This package is separate from the Hub, not a dependency of it. The Hub installs it when
you turn the capture on. The design is in
[LLP 0020](../../llp/0020-emulator-capture-macos.explainer.md) (macOS) and
[LLP 0021](../../llp/0021-emulator-capture-linux.explainer.md) (Linux).

## Requirements

| Host                       | Renderer that the Hub selects | Encoder                         | To install                                   |
| -------------------------- | ----------------------------- | ------------------------------- | -------------------------------------------- |
| macOS 13+ on Apple silicon | `-gpu host`                   | VideoToolbox, part of macOS     | Nothing                                      |
| Linux x86-64               | `-gpu lavapipe`               | x264 build 165, from the system | Ubuntu 26.04: `sudo apt install libx264-165` |

x264 changes its interface with every build, so the Linux agent supports build 165 only.
Ubuntu 26.04 ships it; Ubuntu 24.04 ships build 164, which does not work. The EAS Linux
image `ubuntu-26.04-jdk-17-ndk-r27b-sdk-58` has it installed. Without it, the agent
reports the install command. The Hub preflight checks standard paths and the loader cache;
a confirmed absence boots without the agent and shows the command below the source select.
An inconclusive preflight lets the agent try the actual loader.

## How it works

```text
macOS: display post → GL texture → GPU copy into an IOSurface
         → VideoToolbox rotation, scale and NV12 conversion → H.264 (hardware)
Linux: display post → queue the previous post's handle → capture-worker readback (RGBA)
         → scale and I420 conversion → rotation → x264 → H.264
then:  Unix socket → serve-emu → Device Hub (WebCodecs or WebRTC)
```

- A small agent library is preloaded into the emulator's QEMU process with
  `DYLD_INSERT_LIBRARIES` on macOS and `LD_PRELOAD` on Linux. It hooks the renderer's
  display post with Frida Gum. The emulator itself is not modified.
- With `-gpu host`, the renderer's frames are OpenGL textures. The agent copies each
  frame into an IOSurface on the GPU; the CPU never touches the pixels.
- With a software renderer (`-gpu auto` on a headless Mac picks SwANGLE), the agent
  reads the pixels back instead. Encoding still uses the hardware encoder.
- A Mac without a usable hardware encoder gets the VideoToolbox software encoder.
  The `configured` record and the agent log say which encoder runs.
- On Linux, the agent reads every frame back with the renderer's own readback, on the
  capture worker, using the preceding post's handle. A last post becomes eligible after
  50 ms without another post, within the same requested FPS budget. The worker can still
  contend with the renderer for its lock. It loads x264 when a consumer connects; when x264 is missing,
  the first record says so, and a later connection tries again.
- A consumer connects to the agent's socket, sets the stream size, frame rate and bit
  rate, and receives H.264. Consumers can disconnect and reconnect at any time.
- The agent serves two consumers at once, each with its own encoder and settings: the live
  stream and the recording. The agent copies each frame once for both. The recording keeps
  the panel orientation and one canvas size, places each frame on it with black borders, and
  has a keyframe at least once a second. Expo Device Hub records Android this way, so stream
  changes, rotations and folds do not end its recording.
- When a foldable folds or unfolds, the display size changes. The agent reconfigures
  the encoder and tells the consumer the new size.
- When Android turns the display, the consumer sends the display rotation, and the agent
  turns the picture upright before it encodes it.

## Use with Expo Device Hub

Turn on the capture with the flag, or with the variable for `expo start`:

```sh
npx expo-device-hub --experimental-emulator-capture
EXPO_DEVICE_HUB_EXPERIMENTAL_EMULATOR_CAPTURE=1 npx expo start
```

With the capture on, the Hub:

- installs the matching version of this package with npm, into
  `~/.cache/expo-device-hub/tools/expo-emulator-capture/<version>`, the first time;
- boots emulators with `-gpu host` on macOS and `-gpu lavapipe` on Linux, and with the
  agent once the package is installed (on Linux, also once x264 build 165 is). The agent
  logs to `<tmpdir>/expo-emulator-capture/<serial>.log`;
- streams each emulator that has an agent through it, with scrcpy for input, and makes
  "Emulator capture" the default stream source. Emulators without the agent use gRPC.

The Hub shows "Emulator capture" in the stream source select for every emulator. When the
source cannot work, it is disabled, and a note below the select says why and what to do:
for example, restart the Hub with the flag, or restart an emulator that started without
the agent from the Hub. When the agent turned itself off, for example because an emulator
update removed a renderer symbol that it needs, the note gives the agent's reason.

To use a library that you built, name it instead of the installed package:

```sh
EXPO_DEVICE_HUB_EMULATOR_CAPTURE_LIBRARY="$PWD/dist/darwin-arm64/libexpo_emulator_capture.dylib" \
  npx expo-device-hub --experimental-emulator-capture
```

`/health` on the serve-emu routes reports `captureBackend: "expo-emulator-capture"` and
the capture diagnostics (`framePath`, encoder, native and stream size, resizes, rotation).

## Start an emulator without the Hub

The agent loads only when the emulator starts with it. To start an emulator yourself,
for example in a CI job before the Hub starts, install the package and launch the
emulator through it. Pass `-port`, so the socket is named after the emulator's serial:

```sh
npm install expo-emulator-capture
npx expo-emulator-capture launch -- -avd Pixel_9 -no-window -gpu host -port 5554
```

On Linux, use `-gpu lavapipe` instead of `-gpu host`.

Or set the two variables on the emulator command yourself (on Linux, `LD_PRELOAD` with
`dist/linux-x64/libexpo_emulator_capture.so`):

```sh
DYLD_INSERT_LIBRARIES="$PWD/node_modules/expo-emulator-capture/dist/darwin-arm64/libexpo_emulator_capture.dylib" \
EXPO_EMULATOR_CAPTURE_SOCKET="$(npx expo-emulator-capture socket-path --port 5554)" \
  emulator -avd Pixel_9 -no-window -gpu host -port 5554
```

Both use the socket `<tmpdir>/expo-emulator-capture/emulator-5554.sock`, the place where
the Hub looks for it. Then start the Hub with the capture on; it streams the running
emulator through the agent.

On macOS, set the variables on the emulator command itself. A protected system program
in between, such as `nohup` or a `/bin/sh` that receives the variables, removes `DYLD_*`
variables, and then the agent does not load.

### On EAS

EAS workflows start emulators with `eas/start_android_emulator`, before the Hub starts.
Give that step the agent in its environment:

```yaml
jobs:
  test:
    runs_on: linux-large-nested-virtualization
    image: ubuntu-26.04-jdk-17-ndk-r27b-sdk-58
    steps:
      - uses: eas/checkout
      - name: Install the capture agent
        # Pin the agent to the version that your expo-device-hub release installs: the
        # Hub uses this agent instead of its own (EXPO_DEVICE_HUB_EMULATOR_CAPTURE_LIBRARY).
        run: npm install --prefix /tmp/emulator-capture expo-emulator-capture@<version>
      - uses: eas/start_android_emulator
        with:
          system_image_package: system-images;android-36;google_apis;x86_64
        env:
          LD_PRELOAD: /tmp/emulator-capture/node_modules/expo-emulator-capture/dist/linux-x64/libexpo_emulator_capture.so
          EXPO_EMULATOR_CAPTURE_SOCKET: /tmp/expo-emulator-capture/emulator-5554.sock
          ANDROID_EMULATOR_EXTRA_ARGS: -gpu lavapipe
      - name: Start the Hub
        run: |
          EXPO_DEVICE_HUB_EMULATOR_CAPTURE_LIBRARY=/tmp/emulator-capture/node_modules/expo-emulator-capture/dist/linux-x64/libexpo_emulator_capture.so \
            npx expo-device-hub@<version> --experimental-emulator-capture --platform android &
```

- The first emulator gets the console port 5554, so its serial is `emulator-5554`. EAS
  does not set `TMPDIR`, so the Hub looks for the socket in `/tmp/expo-emulator-capture`.
  On a host that sets `TMPDIR`, use the path from
  `npx expo-emulator-capture socket-path --port 5554`.
- The step passes its environment to every program that it starts, also to `sdkmanager`,
  `avdmanager` and `adb`. The agent stays idle in every process that is not QEMU.
- `EXPO_DEVICE_HUB_EMULATOR_CAPTURE_LIBRARY` lets the Hub use the same agent for emulators
  that it boots itself, instead of installing the package again.
- The image already has x264 build 165. On another Ubuntu 26.04 image, add
  `sudo apt-get install -y libx264-165` before the emulator step.
- One socket serves one emulator, so the step's `count` input, which starts several
  emulators with the same environment, does not work with the agent.
- Use the agent and the Hub from one release. Nothing checks that they match.

### On a host that several users share

The socket directory, `<tmpdir>/expo-emulator-capture`, must belong to the user alone (mode
0700): the agent and the Hub refuse a directory that another user owns or can write. Where
`TMPDIR` is not set, as on most Linux hosts, all users share `/tmp`, so the first user's
directory blocks the others. Give each user a private `TMPDIR`.

## Record without the Hub

Record an emulator's stream to an H.264 file:

```sh
npx expo-emulator-capture record --socket "$(npx expo-emulator-capture socket-path --port 5554)" \
  --output /tmp/capture.h264 --seconds 10 --fps 60 --max-size 1280
```

`--rotation 1` (0 to 3, Android's display rotation) asks the agent to turn the picture
upright for a rotated display. `--role recording` takes the recording consumer instead of
the stream, so a Hub that streams the same emulator does not replace it; `--canvas
1200x2424` sets its fixed canvas. Set `EXPO_EMULATOR_CAPTURE_LOG=/path/to/file` to write the
agent's log to a file. It logs to the emulator's standard error otherwise.

## Build and test

Run from this package directory. You need Bun. The builds download the pinned Frida Gum
devkit for the host and check its SHA-256 digest.

```sh
bun run build             # macOS with Apple silicon and Xcode command line tools:
                          # dist/darwin-arm64/libexpo_emulator_capture.dylib
bun run build:linux-x64   # Linux x86-64 with g++ and the x264 build 165 header
                          # (Ubuntu 26.04: sudo apt install libx264-dev):
                          # dist/linux-x64/libexpo_emulator_capture.so
bun run test              # protocol, conversion and rotation unit tests (C++ and JavaScript)
```

`bun run build` builds only the macOS agent; on other hosts it prints a warning and
produces no binary. `bun run build:linux-x64` fails on any host but Linux x86-64. The
release builds the macOS agent on an EAS macOS job and the Linux agent on an EAS Linux
job, and fails without either.

## Measurements

### macOS

Mac mini M2 (8 GB), Android Emulator 37.2.7, Pixel 10 profile, the same script of
opening apps and a web page with a CSS animation, 2026-11-05. CPU is in cores, above the
same emulator with no stream:

| Source and size            | CPU above no stream | Where it runs                      |
| -------------------------- | ------------------- | ---------------------------------- |
| Hub gRPC stream, 570×1280  | 0.60                | Emulator, ffmpeg (x264), serve-emu |
| Hub gRPC stream, 1080×2424 | 1.31                | Emulator, ffmpeg (x264), serve-emu |
| This capture, 570×1280     | 0.25                | Emulator (GPU copy, VideoToolbox)  |
| This capture, 1080×2424    | 0.32                | Emulator (GPU copy, VideoToolbox)  |

With `-gpu host`, the emulator itself used 0.6 cores during the script. Without the
capture, the Hub starts emulators with `-gpu auto`; a headless Mac then uses a software
renderer, and the emulator used 4.4 cores. Earlier frame rate measurements (2026-11-04):

| Renderer    | Stream              | Frames                    | Render thread per frame | Notes                                     |
| ----------- | ------------------- | ------------------------- | ----------------------- | ----------------------------------------- |
| `-gpu host` | 1080×2424 at 60 FPS | 59–60 FPS in 10 s windows | 0.11 ms                 | GPU frame path, hardware encoder          |
| `-gpu host` | 570×1280 at 60 FPS  | 59.3 FPS                  | 0.12 ms                 | Scaled by VideoToolbox                    |
| `-gpu auto` | 1080×2424 at 60 FPS | 30–34 FPS                 | 25 ms                   | Software renderer; CPU readback limits it |

### Linux

EAS Linux VM (Intel, 22 vCPUs, no GPU), Android Emulator 37.1.11, Pixel 6 profile
(1080×2400) started by `eas/start_android_emulator` with the agent, `-gpu lavapipe`,
2026-11-05 and 2026-11-06, with the earlier synchronous read inside the render post.
These measurements predate the lag plus asynchronous worker and the tail scheduling fixes.
The newer timing matrix is in [LLP 0021](../../llp/0021-emulator-capture-linux.explainer.md#frame-path).
A web page painted each animation frame in the next of eight colors, and every
decoded frame was checked:

| Stream    | Stream FPS | Frames  | Torn | Skipped | Repeated |
| --------- | ---------- | ------- | ---- | ------- | -------- |
| 1080×2400 | 53.4–54.1  | 533–540 | 0    | 19–28   | 71–95    |
| 576×1280  | 54.4–55.5  | 544–555 | 0    | 19–22   | 62–77    |

The ranges cover three runs. The readback took 5.9 to 6.9 ms per frame on the renderer's
thread. Conversion and
encoding took 9.5 to 9.8 ms per 576×1280 frame on the agent's encoder thread.

## Limitations

- Tested only with Android Emulator 37.2.7 (build 16195039) on macOS and 37.1.11 on
  Linux. The agent uses private renderer symbols; it refuses to capture when they are
  missing.
- The agent loads only when the emulator starts with it. Attaching to an emulator that is
  already running is not implemented.
- Only the main display is captured. One consumer for each role, the stream and the
  recording: a new consumer replaces the one of its role, which gets a `replaced` record
  first. The Hub then streams that emulator with gRPC until you select "Emulator capture"
  again, so two Hubs do not take the capture from each other in a loop.
- The EAS macOS VMs cannot run the Android Emulator (Hypervisor.framework reports
  `HV_UNSUPPORTED` there), so the macOS agent was tested only on a physical Mac.
- The Linux agent was tested only on EAS Linux VMs without a GPU. It reads every frame
  back on the renderer's thread, and it supports only x264 build 165.

## Licenses

This package has mixed licenses. Expo's own code is [MIT-licensed](LICENSE). The prebuilt
agent libraries also contain third-party components under their own licenses, among them
Frida Gum (wxWindows 3.1, an LGPL-2.0+ license with a binary exception) and GLib
(LGPL-2.1+). [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) lists every component,
with the license texts in `LICENSES/`. The Linux agent loads x264 (GPL-2.0-or-later) from
the host system; the package does not contain it.

### Temporary Linux PBO experiment

Set `EXPO_EMULATOR_CAPTURE_PBO=1` in the emulator's environment, or write `1` to
`<socket>.pbo` before a consumer starts, to test PBO readback on emulator 37. This
forces `lag-async`, submits a GLES pixel-buffer copy under the renderer lock, and
waits/maps on a capture thread after releasing that lock. It is opt-in and fails
explicitly if its private renderer entry points are unavailable. Remove the file
and variable before a new session to return to the default reader.

This prototype copies mapped bytes into the shared encoder pool; its performance
must include that cost. See [LLP 0023](../../llp/0023-android-recording-independent-of-stream.rfc.md#pbo-experiment)
for the experiment and measurements.
