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
- Point an emulator or simulator at a coordinate from the inspector's Location section.
- Grant, revoke, and reset the foreground app's permissions from the inspector's Permissions section (Android).

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

### Record an Android session

Recording is opt-in and starts with the Hub, even when no browser viewer is connected.
It records one booted Android emulator without audio. There are no recording controls
in the Hub UI.

From a built checkout, with `adb`, `ffmpeg`, and `ffprobe` on your path, run this from
the repository root. Choose a fresh output directory and boot exactly one emulator first.

```sh
node packages/expo-device-hub/dist/server/cli.mjs \
	--platform android \
	--android-recording-directory /tmp/my-android-session
```

To stop, send `SIGTERM` to the Hub process, not its process group, and wait for exit.
Signaling the whole group can kill the encoder before the recording finishes.
On success, `recordings.json` in the output directory lists a subdirectory containing
`recording.mp4` and `session.json`. Failed recordings leave the manifest empty.

Keep the emulator's orientation and capture settings unchanged during recording.
Rotation or capture failure invalidates the recording. A forced kill can leave
unfinished `.partial` files that cannot be recovered by the Hub.

To verify recording and MP4 playback from the repository root, run:

```sh
bun packages/expo-device-hub/scripts/verify-android-recording.ts grpc-screenshot endpoint
```

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
