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

### Require an access token

By default the Hub trusts everyone who can reach it. Pass `--require-token` to gate the iOS
simulator routes (video, input, exec, grid) and Hub device lifecycle actions
(boot, create, shutdown, remove, for both platforms) behind a session token:

```sh
npx expo-device-hub --require-token
```

The Hub mints the token at startup and saves authenticated dashboard links in a private
file (directory mode `0700`, file mode `0600`). Terminal output contains only plain URLs
and the file path, so captured logs do not contain the credential:

```
  Local:   http://localhost:3400
  Session links: /…/expo-device-hub-…/dashboard-links.txt
```

Open a link from that file. The links carry `#token=<token>` so the token does not enter
HTTP request logs. The file is removed when the Hub exits. The dashboard reads the token
once, keeps it for the tab, and drops it from the address bar. Lifecycle requests carry
`Authorization: Bearer <token>`. Every request it makes to serve-sim carries the token: as
`Authorization: Bearer <token>` on fetches, as the `serve-sim.token.<token>` WebSocket
subprotocol on the input and exec sockets, and as `?token=` on the MJPEG stream and the
foreground-app event stream, which cannot set a header. A request without the token gets a
401 and the dashboard reports it.

Another origin that embeds `@expo/hub-client` passes the same token as `accessToken` and
must be allowed on the Hub with `--metrics-cors-origin <origin>` (repeatable, accepts
`https://*.example.com`). That flag opens the HTTP routes cross-origin and lets the page open
the exec socket. Android streaming/control routes remain open because serve-emu has no
token gate yet. The Hub's read-only device-list API also remains open; its lifecycle
actions require the token for both platforms.

### Record an Android session

Recording is opt-in and starts with the Hub, even when no browser viewer is connected.
It records one booted Android emulator without audio. There are no recording controls
in the Hub UI.

From a built checkout, with `adb`, `ffmpeg`, and `ffprobe` on your path, run this from
the repository root. Choose a fresh output directory and boot exactly one emulator first.
With zero or several booted emulators the Hub starts without recording and logs a warning.

```sh
node packages/expo-device-hub/dist/server/cli.mjs \
	--platform android \
	--android-recording-directory /tmp/my-android-session
```

To stop, send `SIGTERM` to the Hub process, not its process group, and wait for exit.
Signaling the whole group can kill the encoder before the recording finishes.

EAS stops the recording before it signals the process. Set
`EXPO_DEVICE_HUB_RECORDING_CONTROL_TOKEN` and send
`POST /_eas/android-recording/stop` with `Authorization: Bearer <token>`. The route answers
200 when a recording was published, 409 with the reason when nothing was recorded, and 401
for every request when the variable is unset. Three variables override the limits:
`EXPO_DEVICE_HUB_RECORDING_MAX_BYTES` (default 4 GiB), `EXPO_DEVICE_HUB_RECORDING_MAX_DURATION_MS`
(default one hour) and `EXPO_DEVICE_HUB_RECORDING_MIN_FREE_BYTES` (default 256 MiB). An invalid
value stops the Hub at startup with the variable name in the error.
On success, `recordings.json` in the output directory lists a subdirectory containing
`recording.mp4` and `session.json`. Failed recordings leave the manifest empty.

Keep the emulator's orientation and capture settings unchanged during recording.
Rotation invalidates the recording. A capture failure does not: the Hub restarts the
capture and the recording continues when the encoder configuration is unchanged. The gap
appears as a held frame. The MP4 is fragmented, so a
forced kill leaves a `recording.mp4.partial` that plays up to the last keyframe before
the kill, about 10 seconds of an active screen at the default keyframe interval. A failed
or timed-out finalization leaves the same file. The Hub does not publish it; EAS uploads it
as a partial recording with the reason from `session.json`.

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
