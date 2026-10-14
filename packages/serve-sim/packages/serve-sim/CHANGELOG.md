# @expo/serve-sim

## 0.9.0

### Minor Changes

- 9d50a4d: Add token-protected simulator pasteboard read and write APIs.
- fc0a29e: Copy selected simulator app text to the browser clipboard from the preview toolbar.
- 69dac3b: Let embedded previews ask the embedding page for clipboard-read permission when a browser clipboard read fails.
- 63f3ac2: Paste browser clipboard text into simulator apps from the preview keyboard or toolbar.
- 89a2f39: Read simulator app clipboard text when simctl cannot access the pasteboard.

### Patch Changes

- e346301: Add `--disable-share` to hide the preview's Share button while keeping the other controls available.
- c65c8b8: Keep iOS session recording in the same MP4 across network-capture reboots, resuming with fresh frames and a keyframe after boot completes. Preserve elapsed timestamps and record reboot interruptions in the manifest.
- b819c39: Report in-process recording shutdown deadline failures without interrupting pending MP4 finalization. Retain the process and device state until finalization completes, then clean up and exit with failure status.
- 27df089: Keep recording through transient control and startup stalls. Preserve an uploadable partial recording after completed encoder-flush failure and allow a fresh recording attempt once that encoder has been invalidated.

## 0.8.0

### Minor Changes

- aafcc8c: Add authenticated app stop and deep-link actions alongside installed-app launch.
- 8019f7f: Add authenticated app data-container lookup, file listing, reading and single-file removal.
- 7633754: Copy staged uploads into app data storage with bounded reads and atomic per-file writes. Each server now stages uploads in its own folder.
- aafcc8c: Add an authenticated app launch action so a running serve-sim session can launch an app installed by its controller.

## 0.7.0

### Minor Changes

- 782fe97: Forward captured traffic through an explicit HTTP proxy with `--network-capture-proxy`,
  including EAS local egress. Basic proxy credentials are supported
  and kept out of capture metadata and the mitmproxy command line. Unconfigured capture goes direct.
- 313ab2e: Accept a colon-separated `SERVE_SIM_ADDITIONAL_DYLIBS` environment variable for simulator boot and app launches alongside the capability loader.
- 3d22378: Choose what network capture keeps from the tools panel. A gear menu next to the capture toggle selects headers, query values, request bodies, and response bodies. A change applies to a running capture without a proxy restart, and the `capture.enable`, `capture.reboot`, and new `capture.fields` host actions accept the same field list.
- dd64572: `serve-sim hinge` with no position prints the foldable simulator's hinge angle, pose, physical orientation, and Table Mode as JSON. After a server restart, serve-sim reads the native hinge angle and restores the last pose, orientation, and Table Mode when the saved angle matches.
- d7349a7: Add --install-app-path to install a local .app after boot and before any requested startup launch. Installation and --launch-app-identifier are independent, so callers can install without launching or install one app and launch another. Validate the app before touching a device, and report installation and validation failures as JSON under --quiet.

### Patch Changes

- f76c5ca: Wait for simulator input admission before sending short CLI input commands, so a full input pool cannot be reported as a successful tap.
- 8450057: Keep regular iPhone preview rotation when returning to portrait-only apps such as Home.
- cf984cc: Avoid repeating simulator initialization before preview startup.
- b7fb493: Stop reading and re-wiring a simulator's framebuffer while the simulator is not booted. A capture left open after a shutdown called into the dead simulator once a second, which leaked memory and, over days, CPU.
- e4e11f5: Require successful Simulator boot completion before launching an installed app or reporting readiness. In the foreground CLI, report boot, launch and deep-link startup failures as JSON under --quiet.
- e49a254: Keep toast dismissal timers running after touch taps on screenshot and other preview notifications, while preserving mouse hover pauses.

## 0.6.3

### Patch Changes

- dd19174: Combine browser wheel deltas per display frame after sending the first event immediately, and cancel buffered scrolling when touch input starts, the page becomes hidden, or the preview is cleaned up. Requires a simulator host that buffers excess wheel distance across screen-edge reanchors.

## 0.6.2

### Patch Changes

- 19801ba: Recover simulator capture after framebuffer loss or silent surface swaps, with recovery logs and stats.
- 0a1c7a9: Deliver input rejection codes and reasons reliably before closing the underlying connection, while bounding cleanup for unresponsive clients.
- 20931f1: Optimize session recording MP4s for network playback so players can load the recording index before downloading the media. Keep the encoder-flush timeout from cancelling MP4 finalization, and report its duration in the recording log. Recording bitrate and resolution are unchanged.
- dcc46a5: Session recordings now request keyframes every 60 submitted frames or one second of recording time, instead of 120 frames, reducing decoding work when seeking. Source pauses can leave longer gaps; the first resumed frame is a keyframe. A still screen records about 8 MB a minute instead of 4.6; with motion, recordings grow by about 10%.
- c8a9613: Reduce input delays after wheel scrolling by pacing accumulated scroll movement without waiting for the gesture idle timeout on each input message.

## 0.6.1

### Patch Changes

- f78dec6: Internal change: session tokens must not be empty and can now contain only letters, digits, and `-._~`. Other tokens are refused, and the CLI tools throw an error.

## 0.6.0

### Minor Changes

- e066832: Add `GET {base}/api/apps/icon?bundleId=<id>`, which returns an installed app's icon as `{ok, bundleId, icon: {mimeType, data} | null}`, the same shape as serve-emu's route, with `bundleId` in place of `packageName`. `/api` advertises it as `appIconEndpoint`. A remote client behind a tunnel can read the icon with one request, and does not need the exec-ws socket.

## 0.5.0

### Minor Changes

- 4e80b34: `POST /api/screenshot` reports the session artifact save in the
  `X-Expo-Screenshot-Artifact` and `X-Expo-Screenshot-Artifact-Error` headers,
  and the tunneled preview's screenshot toast says whether the capture was saved
  to the session artifacts.
- f68dd10: Save each `/api/screenshot` capture to `EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY`
  when it is set, and record each manual screenshot in the event log.
- 08a589f: An ungated preview now answers only for `localhost` and IP addresses. Other `Host` headers get 403, which stops a DNS rebinding page from reading the session token. Pass `--allow-any-host-when-insecure` (`allowAnyHostWhenInsecure` when embedding) to answer for any name; that is insecure without `--require-token`. Token-gated previews are unchanged.
- fca3213: Export network capture as HAR. The tools panel downloads the session HAR, `{base}/network-capture.har` and `{base}/network-capture.ndjson` serve it, and `serve-sim capture har -o <path>` keeps a separate recording that starts with the session's earlier requests and continues through capture restarts. A recording that already holds requests is replaced only with `--force`.
- 8b80983: Add a network capture panel to the preview tools: live requests grouped by host, with status, timing, and size, and each request's headers and bodies when capture keeps them. The panel turns capture on or off, clears the list, and shows why a request has no body.
- 58266fb: Record native video with a hardware H.264 session, and resize viewer frames on their own queue instead of the frame pump.
- 30ed543: Reuse one native-resolution simulator capture for recording and WebRTC viewers, avoiding a second framebuffer read while keeping viewer scaling separate.
- a68a224: Add network capture for iOS simulators. `--network-capture` records HTTP(S) traffic from third-party apps through a local mitmproxy, metadata only by default; `--network-capture-field` opts into headers, query values, and bodies, with credential headers redacted. Capture requires mitmproxy. On a host reachable beyond loopback, serve-sim allows it only with `--require-token`, and expo-device-hub, which has no token gate, refuses it.
- fd8d7da: Add `serve-sim record-video` and finalize active recordings during shutdown.
- 7ceafdb: Share one H.264 encode across WebRTC viewers, with one shared resolution for all viewers and recovery for a peer that libwebrtc reinitializes.

### Patch Changes

- b6a50db: Cover network capture with an end-to-end test that sends real app requests through the capture proxy, including startup requests, headers, query values, and a 3 MB upload.
- 1e72199: Restore iPhone Duo touch input after the simulator reboots in the same serve-sim process. The reset applies only to the rebooted device, so other devices on the server keep their input.
- fa99cc3: Stabilize crash ingestion and keyboard focus end-to-end tests by grouping a seeded recurrence of one OS-written crash and waiting for the preview input socket to open.
- 1ff3fd9: Hold the shared WebRTC H.264 encoder to its target bitrate over short windows, and send a keyframe to a viewer whose sender paused briefly once the one-second refusal limit ends. `/webrtc/stats` reports the pump's timer lateness, libwebrtc submit time, and `sharedCanvas.lowLatencyFallbacks`, the times the shared encoder fell back from low-latency to default rate control. The video frame rate menu offers 120 fps (the MJPEG menu stays at 60).
- b8ed56a: Skip WebRTC frames whose content did not change, and send each fresh frame when it arrives, up to 1.5 times the configured frame rate. The latest frame still repeats at the configured rate while the screen does not change.
- 9800ffa: Release stale simulator input sockets after missed pongs and retry temporary input refusals in the preview.
- 955a928: Keep the preview server's own port in a device's state when a device is started through a tunnel, whose Host header carries no port. The state no longer points at port 0, so metrics and recording reach a second device.
- c907e7f: Document the native video pipeline: shared encode, hardware recording, and the viewer resize queue.

## 0.4.0

### Minor Changes

- 38af3d4: Publish `@expo/serve-sim` from the `expo-device-hub` monorepo. Versions start at 0.4.0, above the 0.3.4 release from `expo/serve-sim`.
