<p align="center">
  <a href="https://github.com/expo/expo-device-hub">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/expo/expo-device-hub/main/assets/expo-device-hub-banner-dark-2x.png">
      <img alt="Expo Device Hub" src="https://raw.githubusercontent.com/expo/expo-device-hub/main/assets/expo-device-hub-banner-light-2x.png" width="838">
    </picture>
  </a>
</p>

# expo-device-hub

**Expo Device Hub** is an [Expo DevTools plugin](https://docs.expo.dev/debugging/devtools-plugins/)
that lets you preview and control your iOS simulators and Android emulators right from
the browser — without leaving your development workflow. When you run `expo start`, the
Hub adds a device dashboard where you can watch a live stream of any device, interact
with it, and manage which devices are running from one place.

## Features

- Live stream of iOS simulators and Android emulators in your browser.
- Interact directly — tap, swipe, scroll, and type into the device.
- Boot, shut down, and add devices without opening Xcode or Android Studio.
- Follows your system light/dark theme, and can flip the device's appearance too.
- Feed an Android emulator's camera a PNG from the inspector's Camera section.

> iOS simulators require macOS with Xcode. Android emulators require the Android SDK
> (`emulator`, `adb`).

## Installation

> Using the Hub inside an Expo app requires **Expo SDK 57** or newer.

```sh
npx expo install expo-device-hub
```

## Usage

Start your project as usual:

```sh
npx expo start
```

Expo Device Hub registers itself as a DevTools plugin, so a link to it appears in your
terminal when the dev server starts:

```
› Expo Device Hub: http://localhost:8081/_expo/plugins/expo-device-hub
```

## CLI

The Hub also runs outside of `expo start` as a standalone server — useful when you want
the device dashboard without a running Expo project:

```sh
npx expo-device-hub
```

Android streams use the emulator screenshot gRPC source with MMAP delivery by default,
both in the Expo CLI plugin and the standalone CLI. MMAP sends frame metadata over gRPC
while the emulator writes RGB pixels to a shared file-backed memory region:

```sh
npx expo-device-hub --platform android --transport webrtc
```

Use `--stream-source scrcpy` to select scrcpy at startup, or `--grpc-image-mode png` to
send a compressed image in each gRPC message. Use `--grpc-image-mode rgb888` for raw
RGB888 pixels inside each gRPC response. The same source and PNG/MMAP/RGB888 choices
are available at runtime under **Stream options**. Run `npx expo-device-hub --help`
for the full option list.

```sh
npx expo-device-hub --platform android --stream-source grpc-screenshot --grpc-image-mode rgb888
```

Programmatic serve-emu options accept
`{ streamMode: "grpc-screenshot", grpcImageMode: "rgb888" }`. Hub's shared dashboard
selector applies the choice through the embedded serve-emu `PUT /api/stream-mode`
endpoint with `{ "mode": "grpc-screenshot", "grpcImageMode": "rgb888" }` (under
`/vendor/serve-emu` in Hub). The applied selection updates when the replacement
stream renders, and failed replacements preserve the previous selection.

RGB888 response bytes are validated and passed to ffmpeg/libx264 as `rgb24`,
without MMAP allocation or verification rereads and without PNG in the continuous
capture stream. This still involves emulator GPU-to-CPU readback, not texture
sharing or hardware encoding. It is not zero-copy or guaranteed faster. Source
frame rate, locally paced encoder submissions, gRPC payload bytes and decode
timing remain separate in capture statistics. MMAP remains the Hub default.

To measure incoming gRPC responses, sample `grpcCapture.rawGrpcMessagesReceived`
from `/vendor/serve-emu/health?device=<serial>` and divide the counter difference
by the elapsed seconds within the same capture session. This counter increments
when a complete gRPC response has been assembled, before protobuf decoding,
MMAP reads, frame selection, and encoder writes. Count differences include idle
time; the displayed **Host receive FPS** is an active-cadence estimate that can
retain its last value while idle. RGB888's normal capture path also pauses the
HTTP/2 stream for local pacing, so received response rate is not a measurement
of every frame rendered internally by the emulator.

MMAP uses gRPC metadata notifications to trigger selected shared-memory reads;
it does not continuously poll the file. After the stream has delivered a message,
10 seconds without another decoded stream message triggers a unary
`getScreenshot` probe. A successful MMAP probe triggers a fresh shared-memory
read. These probes do not increment the stream notification counter. Repeating
the cached image for the encoder also does not imply a new gRPC response or a
new MMAP read.

MMAP support is experimental and depends on the Android Emulator build. Google
tracks an Apple Silicon `streamScreenshot` MMAP fix as issue
[#537802959](https://issuetracker.google.com/issues/537802959), included in
Emulator 37.2.3 Canary. If an affected emulator crashes or stops producing
frames, select PNG explicitly or upgrade to a build containing that fix.

## Acknowledgements

Device streaming and control are powered by two vendored, Apache-2.0-licensed
dependencies, bundled from Expo's forks. Each fork's license travels with the
vendored code:

- **[`@expo/serve-sim`](https://github.com/expo/expo-device-hub/tree/main/packages/serve-sim)** —
  iOS simulator streaming and input; a fork of
  [EvanBacon/serve-sim](https://github.com/EvanBacon/serve-sim).
  License: [`vendor/serve-sim/LICENSE`](./vendor/serve-sim/LICENSE).
- **[`@expo/serve-emu`](https://github.com/expo/expo-device-hub/tree/main/packages/serve-emu)** —
  Android emulator streaming and input; a fork of
  [jiunshinn/serve-emu](https://github.com/jiunshinn/serve-emu).
  License: [`vendor/serve-emu/LICENSE`](./vendor/serve-emu/LICENSE).

## License

MIT — see [LICENSE](./LICENSE).

Bundled dependencies keep their own licenses under [`vendor/`](./vendor); see
[Acknowledgements](#acknowledgements) above.
