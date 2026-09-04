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

Use `--stream-source scrcpy` to select scrcpy at startup, `--grpc-image-mode png` to
send a compressed image in each gRPC message, or `--grpc-video-codec vp8` (also `vp9`)
to change the host encoder for WebSocket streaming. The same source, PNG/MMAP, and
H.264/VP8/VP9 choices are available at runtime under **Stream options**. VP8 and VP9
require WebCodecs and are unavailable with WebRTC. Run `npx expo-device-hub --help`
for the full option list.

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
