# expo-device-hub

## 0.18.0

### Minor Changes

- c2ae06b: Paste and copy text between the browser and an iOS Simulator using the dashboard Clipboard menu or Command+V/Command+C. Show centered clipboard feedback, offer manual clipboard fields when browser access is blocked, and release the clipboard reader when the CLI stops.

### Patch Changes

- 563b357: Refresh the shared Hardware Keyboard setting when another viewer changes it. Hub connections still start with Hardware Keyboard off so browser-layout typing works.

## 0.17.3

### Patch Changes

- 69f5907: serve-emu now omits scrcpy server options that already hold the server default. With the Hub's default stream settings, the `app_process` command line drops from 344 to 198 bytes. Some Samsung devices, such as the Galaxy M22, abort the scrcpy server when the command line exceeds about 255 bytes, and the Hub listed them but never started their stream. Custom serve-emu settings, such as `--repeat-frame-ms` with a non-default bitrate, can still exceed that length.

## 0.17.2

### Patch Changes

- 3fc89c6: Expose `inputError` on `DeviceScreenClient`, and keep Android video live when only the input socket fails. Render the input-error notice in the Hub phone frame while consumers continue to own their UI.
- 0eccaea: Android screenshots of a foldable emulator are valid PNGs of the screen in use. Before, `screencap` added a warning in front of the image and captured the inner display, which is off while the device is folded.

## 0.17.1

### Patch Changes

- 14850d3: Accept serve-sim's share options for interface compatibility. They have no effect in the Hub.

## 0.17.0

### Minor Changes

- 9d50a4d: Ship the serve-sim pasteboard helper, so Hub simulator previews can use the token-protected pasteboard read and write APIs.
- fc0a29e: Copy selected simulator app text to the browser clipboard from the Hub preview toolbar.
- 69dac3b: Let embedded Hub previews ask the embedding page for clipboard-read permission when a browser clipboard read fails.
- 63f3ac2: Paste browser clipboard text into simulator apps from the Hub preview keyboard or toolbar.
- 89a2f39: Read simulator app clipboard text in Hub previews when simctl cannot access the pasteboard.
- 27d5a91: Add `--cors-origin <origin>` to let a page on another origin use the Hub with `@expo/hub-client`, on iOS and Android. It takes the same values as serve-sim's `--cors-origin`: an origin, or a subdomain wildcard such as `https://*.expo.dev`.

### Patch Changes

- c65c8b8: Keep iOS session recording in the same MP4 across network-capture reboots, resuming with fresh frames and a keyframe after boot completes. Preserve elapsed timestamps and record reboot interruptions in the manifest.
- b819c39: Preserve iOS recording finalization during shutdown and clean up capture when startup is interrupted.
- 27df089: Keep iOS recordings through transient control stalls, and preserve partial recordings when encoder finalization fails.
- c42a827: The Hub now discards an upload that it answers without reading, such as one the token gate refuses or one whose route fails. Before, a large refused POST stayed paused, and the next request on the same keep-alive connection waited forever.
- c42a827: Under `--require-token`, the Hub's 401 for a missing token on a serve-sim or serve-emu route now carries that backend's CORS headers. A page that the backend allows, such as a `--cors-origin` page, can read the refusal instead of getting a network error.
- 8ab2a61: serve-emu now answers every route with its CORS policy and answers every preflight, as serve-sim does. A page on a loopback origin can use the Android backend of a Hub on a loopback address, and an allowed cross-origin page can read the screenshot artifact headers. `allowedOrigins` also takes serve-sim's subdomain wildcard, such as `https://*.expo.dev`.

## 0.16.0

### Minor Changes

- 5317c57: The CLI now records the metadata of each running Hub in `server-<port>.json` in `$TMPDIR/expo-device-hub` (or `EXPO_DEVICE_HUB_STATE_DIR`).

### Patch Changes

- 3e3c70a: Find the Android SDK in predefined search paths when `ANDROID_HOME` is not set.
- cf4c0b2: Advance the iOS Rotate button through requested orientations while screen readback is delayed or an app declines a pose.
- c49d95a: Add a `/healthz` endpoint that answers `200 {"status":"ok"}` without the session token.
- cf4c0b2: Wait for helper admission before sending iOS input when the helper advertises `inputAdmission`. Legacy helpers continue accepting input when the socket opens.
- 8450057: Keep regular iPhone preview rotation when returning to portrait-only apps such as Home.

## 0.15.3

### Patch Changes

- 16a6fed: Read and update Android appearance asynchronously, and keep device controls in sync with appearance changes made on the device.
- c731773: `deviceSettingsStatus` now reports iOS discovery, connection loss, and recovery, so consumers no longer need the video status. Failed refreshes report `'error'` and keep cached settings. The Hub dashboard disables unavailable settings.
- dd19174: Combine browser wheel deltas per display frame after sending the first event immediately, and cancel buffered scrolling when touch input starts, the page becomes hidden, or the preview is cleaned up. Requires a simulator host that buffers excess wheel distance across screen-edge reanchors.

## 0.15.2

### Patch Changes

- 4822dc0: Keep the Node server running when middleware rejects a POST and cancels its unread body. Return the rejection response and drain the remaining upload without closing the response socket.
- b2f5247: Release held Android touches when a preview tab disconnects, without lifting another viewer's touches.
- f78dec6: Internal change: session tokens must not be empty and can now contain only letters, digits, and `-._~`. Other tokens are refused, and the CLI tools throw an error.
- 5f863e0: Run `avdmanager` and `sdkmanager` on Windows, where they ship as `.bat` wrappers.

## 0.15.1

### Patch Changes

- ffa6c99: Stream physical Android devices over scrcpy instead of inheriting the emulator-only `grpc-screenshot` default, and stop broadcasting `video-session` for scrcpy restarts that keep the same size, which sent WebCodecs viewers into a keyframe-reset loop.

## 0.15.0

### Minor Changes

- 4ec7c01: Add `--require-token` to the standalone CLI, the same flag as in serve-sim. The CLI mints a session token and prints links that carry it. The dashboard, the Hub API, the vendored serve-sim and serve-emu routes, and every WebSocket then need the token: a link trades it for an HttpOnly cookie, scripts send `Authorization: Bearer <token>`, and a page load without it shows a token form. `/readyz` stays open. `--frame-ancestor <origin>` lets another site frame the gated Hub. A Hub that listens on the network without the flag now prints a warning.
- 9d3266f: Append emulator flags from `EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS` when the Hub boots an Android emulator, e.g. `-gpu host` to render on the host GPU instead of the software renderer `-gpu auto` picks without a window.

## 0.14.0

### Minor Changes

- fec1fc2: The vendored serve-emu now accepts only `POST /api/screenshot`; `GET` returns 405.
- ca5ae0e: Show a screenshot toast in the dashboard with a thumbnail, a "Download again" action, and the session artifact outcome, in place of the status line under the controls.
- f68dd10: Save preview screenshots to `EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY` when it is
  set. On iOS, each manual screenshot appears as an event.
- a68a224: Add network capture for iOS simulators. `--network-capture` records HTTP(S) traffic from third-party apps through a local mitmproxy, metadata only by default; `--network-capture-field` opts into headers, query values, and bodies, with credential headers redacted. Capture requires mitmproxy. On a host reachable beyond loopback, serve-sim allows it only with `--require-token`, and expo-device-hub, which has no token gate, refuses it.

### Patch Changes

- 08a589f: An ungated preview now answers only for `localhost` and IP addresses. Other `Host` headers get 403, which stops a DNS rebinding page from reading the session token. Pass `--allow-any-host-when-insecure` (`allowAnyHostWhenInsecure` when embedding) to answer for any name; that is insecure without `--require-token`. Token-gated previews are unchanged.

## 0.13.0

### Minor Changes

- 980ff0a: Sync the vendored serve-sim with `@expo/serve-sim` 0.3.4 (upstream `expo` branch at `c91e75b`).

## 0.12.0

### Minor Changes

- 1b3086e: Expose Android emulator fold capability, posture, hinge angle, and confirmed fold/unfold controls through serve-emu.

## 0.11.0

### Minor Changes

- 8cbaa35: Add an Accessibility inspector section that lists the accessible elements of the current iOS or Android screen and taps one on click.
- 6d11421: Show live CPU, memory, and network charts for the foreground Android app.
- 3d13723: Show the real launcher icon of the foreground app on Android. serve-emu gains
  `GET /api/apps/icon`, which pulls the base APK and resolves the adaptive icon's
  foreground bitmap with `aapt2`.
- 49275f5: Add pinch and pan on Android. Alt-drag or two fingers on the streamed screen now reach the emulator as two pointers.
- 620512c: Add an Android on-screen keyboard control to the shared device options UI.
- 66c48ed: Add a Permissions section that lists the foreground app's permissions and can grant, revoke, or reset them on Android emulators. iOS follows once serve-sim serves them over HTTP.
- 6d17e43: Add a Location inspector section that points an Android emulator or an iOS simulator at one coordinate, by preset or by typed latitude and longitude. iOS can also clear the fix.
- 12616f5: Allow clients to select the active iPhone Duo surface without changing the hinge angle.
- ada9916: Update the vendored serve-sim to `@expo/serve-sim` 0.3.0 (upstream `expo` branch).

### Patch Changes

- de58f2a: Show Android screen recording status in the Hub.

## 0.10.1

### Patch Changes

- 5ee7d90: Forward gRPC frames to FFmpeg as soon as its input is ready.

## 0.10.0

### Minor Changes

- 56e6f33: Add Android reduce-motion and increase-contrast controls to the shared device options UI.
- 06df67a: Add an Android bold-text control to the shared device options UI.
- ed1da9f: Add an Android display-size control to the shared device options UI, with the resulting smallest-width dp shown beneath it.
- 1e08984: Add optional hardware H.264 encoding for Android gRPC streams.
- c4418f3: Use RGB888 delivery by default for Android gRPC streaming.
- 2f4934a: Add RGB888 image delivery over gRPC to Android streaming.
- a18d697: Add Video FPS and Video bitrate controls to Android stream options for WebSocket and WebRTC playback.
- 9d73330: Default to 60 FPS streaming for both iOS and Android.
- e107419: Add camera image passthrough for Android emulators.

### Patch Changes

- 5755ea6: Prevent the connecting overlay from flashing during a quick initial server connection.

## 0.9.0

### Minor Changes

- 36dd944: Add selectable scrcpy and emulator-gRPC input delivery for gRPC Android streams, defaulting gRPC capture to scrcpy input.
- 76d7e34: Redesign the dashboard to the new Expo look.

### Patch Changes

- 2f34c96: Preserve 60 FPS Android gRPC MMAP capture under normal notification and encoder-timer jitter.

## 0.8.0

### Minor Changes

- c56f6d5: Add runtime Android stream resolution and capture-source controls, explicit PNG/MMAP delivery for the emulator gRPC source in the CLI and UI, use the 60 FPS capture default, expose producer-to-client pipeline diagnostics, and accurately count browser-presented frames while preserving the Hub session across stream restarts.
- d6c1ae8: Add WebRTC stream statistics. Move Android network and font-scale compatibility routes to serve-emu.

## 0.7.1

### Patch Changes

- e2ca548: Honor `X-Forwarded-Proto` in the standalone CLI so WebRTC signaling works behind TLS-terminating reverse proxies.

## 0.7.0

### Minor Changes

- 09ec254: Add a `--hide-boot-device` CLI option that hides controls for booting and creating devices.

### Patch Changes

- 5065b02: Show a compact stream-status pill above the device frame and reveal its identifier on click.

## 0.6.0

### Minor Changes

- ce7fec2: Add Android network and font-size controls to the shared device options UI.
- b1e9c36: Add Android WebRTC streaming

### Patch Changes

- bf38c74: Send iOS screenshot requests with POST to match the updated serve-sim endpoint.

## 0.5.0

### Minor Changes

- 9897a47: Add agentic cursor visuals for argent
- 2ef9430: Add device options, activity graphs, device events, stream controls, and collapsible log sections for iOS sessions.
- 14be971: Add `--hide-sidebar` to the standalone CLI.
- be2b818: Add standalone CLI flags for configuring serve-sim streaming, WebRTC ICE, and metrics CORS.
  Expose EAS-compatible readiness and temporary serve-sim-backed metrics endpoints.

## 0.4.0

### Minor Changes

- 1e21217: Add `--platform ios|android` to the standalone CLI.
- d906816: Add keyboard input and simulator keyboard controls.
- 571207b: Add H.264, and WebRTC iOS simulator streaming.
- e106f9b: Add `--transport mjpeg|h264|webrtc` to the standalone CLI.

## 0.3.0

### Minor Changes

- d5c3290: Added UI to create new simulators and emulators based on the available SDKs.
- f7f6486: Add currently opened application metadata.
- b6d3b9f: Added fullscreen compact view to maximize the device view when used in agentic UIs.

### Patch Changes

- 93a310a, 9282d67: Fixed reading of the last boot timestamp of recent simulators and emulators.

## 0.2.1

### Patch Changes

- f32c4e3: Restore the iOS Save screenshot action. serve-sim's `/api/screenshot` route was lost in its fetch-style middleware rewrite, so the dashboard's Save button silently did nothing for simulators.

## 0.2.0

### Minor Changes

- ce37414: Add a standalone CLI (`npx expo-device-hub`) that serves the Hub dashboard.

### Patch Changes

- 5a98e6d: Add resizable sidebars. Drag the vertical seam between either sidebar.
- 85599c2: Add device rotation support. A Rotate action in the stream controls More menu.

## 0.1.1

### Patch Changes

- 28f3787: Performance and design updates.

## 0.1.0

### Minor Changes

- 4c8cdd7: Initial release
