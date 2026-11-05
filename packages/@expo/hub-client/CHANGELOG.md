# @expo/hub-client

## 1.10.0

### Minor Changes

- c27ada7: Report the same device-screen loading states on iOS and Android. `status` is `'connecting'` only until the current screen session shows its first frame, and it becomes `'error'` after 30 seconds without a frame while the client keeps retrying. After the first frame, a lost stream is `'reconnecting'` on both platforms, and the last frame stays on screen: iOS WebRTC keeps it as a poster, as Android does, and an iOS MJPEG retry loads off screen before it replaces the frame. A helper restart for the same iOS device keeps the stream mode, the screen's shape, the touch mapping, the iPhone Duo's 3D model, and, while the helper keeps its URL, the H.264 fallback. On iOS, a reconnect that lasts 30 seconds becomes `'error'` ("Disconnected — retrying…") over the last frame while the client keeps retrying. A WebRTC transport retry, an iOS MJPEG retry, and an iOS H.264 re-read are no longer reported as errors. The new `framePresented` field on `DeviceClient` and `DeviceScreenClient` tells whether the session has shown a frame. A new device, server, token, transport, or display surface starts a new session. `useVisibleTimeout` runs a callback after a wait that counts only while the tab is visible, for your own loading UI.

  Two kinds of consumers must change code:

  - `DeviceScreen` now renders only the media and the input surface. It no longer draws a black background, "Connecting…", "Not connected", or the error text, and its `<img>` has an empty `alt`. If you relied on that overlay, draw your own connecting, reconnecting, and error states from `status`, `error`, and `framePresented`.
  - Custom `DeviceClient` and `DeviceScreenClient` implementations and mocks must add the new required `framePresented` field: `true` once the current screen session has presented a frame, also while it reconnects; `false` before that.

- 10815bf: Add foldable device support, starting with the iPhone Duo. `DeviceClient.fold` reports the fold state (hinge angle, named pose, Table Mode, and how the device is held) and takes fold commands. `capabilities.fold` lists the commands that a device accepts, and `FOLD_POSES` names the poses that all foldables share. `fold.observe` reports the steps of each command, from its request to its outcome; a queued command that a newer one replaces gets only its request. `DeviceClient.displays` streams each display (`cover`, `inner`) into an element that you attach, with the transport, codec fallback, and session token of the flat stream. Touch, multi-touch, and scroll samples can address one display, and `screen.display` names the display that the screen describes. `DeviceClient.deviceModelUrl` points to a 3D model of the device, Xcode's for the iPhone Duo. `useDeviceKeyboard` and `listenForInputCancellation` give your own device surface the keyboard and input-release handling of `DeviceScreen`.

  hub-client is alpha, so a minor release like this one can need code changes. Custom `DeviceClient` implementations and mocks must add the required members `fold`, `displays`, `deviceModelUrl`, `displayCorners`, and `capabilities.fold`. A client for a device that does not fold and has one stream uses `fold: null`, `displays: null`, `deviceModelUrl: null`, `displayCorners: null`, and `capabilities.fold: false`. Custom `DeviceScreenClient` values passed to `DeviceScreen` must also add `fold` and `capabilities.fold`, with the same values for a device that does not fold.

### Patch Changes

- de14fb6: Show the whole iPhone Duo cover screen in the 2D WebRTC stream. The picture was stretched and its right edge was cut, which showed as a dark stripe. serve-sim now draws it from the top-left corner of the shared canvas, with black bars right after the picture, and the screen views pin the frame to the top-left.
- 79221df: On the iPhone Duo, a fold change that you request now holds in `client.fold` until the simulator reports it, or for at most 500 ms after the command's config, so the fold does not jump back while the simulator catches up. The `confirmed` fold event has `observed: false` when that limit ran out first. An observed angle within 1° of a preset now names that preset.

## 1.9.0

### Minor Changes

- a6b40fa: Add `recordingLock`, the reason a running Android recording locks rotation and stream changes, and `recordingControlsLocked`; calls to the locked controls are silently ignored meanwhile. `areRecordingControlsLocked` is deprecated in favor of `recordingLock`. Custom `DeviceClient` implementations and mocks must add these required members.
- 0c8f2a8: Add `setOrientation` and `capabilities.orientation` to turn a device to one pose, with `orientation`, `orientationPending` and `orientationError` showing the pick and then the backend's answer, `orientationUnavailable` giving the reason a change cannot go out now, and Android Rotate now steps through the same four poses as iOS. Custom `DeviceClient` implementations and mocks must add these required members.

### Patch Changes

- 8589ebf: Offer only the Android stream modes that serve-emu lists in `/api` `viewerTransports.available`. On a `--transport webrtc` host, H.264 is not offered and an H.264 choice falls back to WebRTC. Older serve-emu versions without the list keep the WebSocket video.
- 20cc264: Fit the Hub viewer above the phone keyboard, add mobile keyboard and full-screen controls, group the inspector toggle with those controls, and give the device more room on small screens.

## 1.8.1

### Patch Changes

- 660da0e: Retry temporary Android WebRTC offer conflicts when capture or the device session changes during setup.

  Refuse standalone Android WebRTC offers for a selected device that is no longer active, so recovery cannot connect to a different device.

- 174f551: Advertise the effective Android idle repeat interval and recover gRPC screenshot streams that stop delivering frames, while allowing scrcpy and slow custom repeats to stay idle. Indicate pending automatic recovery when a locked iOS codec ladder restarts.

## 1.8.0

### Minor Changes

- 563b357: Add text Paste and Copy for iOS simulators: `DeviceClient.pasteText`, `copyText`, `clipboardActionId`, `clipboardAction`, `clipboardPending`, `clipboardError`, `clipboardWarning` and `capabilities.clipboard`. Keys typed after a Paste wait for it. `DeviceScreen` pastes the browser's text on Command+V when the helper supports Paste. It routes Command+C through an optional host `onCopy` callback when Copy is supported; without it, Command+C stays native keys. HubClient and `DeviceScreen` do not show clipboard results; the host page shows `clipboardError` and `clipboardWarning`.

  Custom `DeviceClient` implementations and mocks must add these required members; unsupported clients use `capabilities.clipboard: false`, `clipboardActionId: 0`, null action/status fields, and methods that reject as unavailable.

### Patch Changes

- 563b357: Refresh the shared Hardware Keyboard setting when another viewer changes it. Hub connections still start with Hardware Keyboard off so browser-layout typing works.

## 1.7.0

### Minor Changes

- 3fc89c6: Expose `inputError` on `DeviceScreenClient`, and keep Android video live when only the input socket fails. Render the input-error notice in the Hub phone frame while consumers continue to own their UI.

### Patch Changes

- 99a8a36: Cancel held gestures, keys and paced input when a client changes or loses focus. Preserve unsent queued commands when a WebSocket send fails.

## 1.6.1

### Patch Changes

- 821d0a3: Keep WebRTC peers connected during intentional capture reboots and resume normal playback recovery afterward.
- 58c4fe3: Share one iOS control channel between settings, actions, logs, events and activity. Removing one subscription preserves the others.
- 9f9f8d4: Add a client-owned control channel for concurrent requests and independent subscriptions, without replaying writes after disconnect.
- a37fd27: Match serve-sim's asymmetric H.264 offer level for large iOS Simulator surfaces. Android offers retain their original level.
- 0b680d3: Wait for advertised serve-sim input admission before sending commands or clearing refusal errors. Preserve legacy servers and allow heartbeat recovery before reporting occupied input slots.
- 6381624: Add admission-aware iOS input connection handling with bounded queuing and refusal recovery.
- a9a8ebe: Preserve browser-layout printable characters in iOS key messages and consume layout differences through the helper's software keyboard, while preserving shortcuts and HID fallback.
- 2e4378f: Add the playback stall classification and recovery policy.
- ff33fa6: Recover frozen WebRTC playback using one shared, bounded stats poll for the watchdog and diagnostics. Reconnect once before demoting a codec on a repeated decoder stall.
- efbe26b: Bound ordinary WebRTC teardown and retry only offer contention, preserving lasting signaling errors.
- cb4b181: Pause WebRTC failure diagnosis while hidden and use session-scoped sender stats to distinguish missing media from codec failure. Resume paused video on both platforms and reattach replacement video elements without replacing the peer.
- 88b9eed: Bound WebRTC stats reads and avoid accumulating browser reads when a peer stops answering.
- f97577a: Keep iOS sessions with an advertised WebRTC transport on WebRTC during transient failures and codec recovery.

## 1.6.0

### Minor Changes

- 190a904: Expose activity readiness independently of video.

### Patch Changes

- cf4c0b2: Advance the iOS Rotate button through requested orientations while screen readback is delayed or an app declines a pose.
- cf4c0b2: Wait for helper admission before sending iOS input when the helper advertises `inputAdmission`. Legacy helpers continue accepting input when the socket opens.
- 66ca088: Keep settings available when other streams restart and prevent duplicate writes.

## 1.5.0

### Minor Changes

- 16edd92: Add `DeviceClient.deviceSettingsStatus` to distinguish loading, ready, and failed settings reads on iOS and Android.

### Patch Changes

- 16a6fed: Read and update Android appearance asynchronously, and keep device controls in sync with appearance changes made on the device.
- c731773: `deviceSettingsStatus` now reports iOS discovery, connection loss, and recovery, so consumers no longer need the video status. Failed refreshes report `'error'` and keep cached settings. The Hub dashboard disables unavailable settings.
- d3db352: Keep device settings in sync every five seconds while the browser tab is visible.
- dd19174: Combine browser wheel deltas per display frame after sending the first event immediately, and cancel buffered scrolling when touch input starts, the page becomes hidden, or the preview is cleaned up. Requires a simulator host that buffers excess wheel distance across screen-edge reanchors.

## 1.4.0

### Minor Changes

- 320a7d5: Add `DeviceClient.inputError`. On iOS it reports when serve-sim refuses the
  input socket (too many clients or a full input queue) or reports
  `inputUnavailable`, and clears when input works again. On Android it reports
  a down WebRTC input socket.

### Patch Changes

- d7b3d1b: Report only the iOS stream modes that serve-sim advertises in `/api`: an HTTP server no longer offers WebRTC, and a WebRTC server no longer offers MJPEG or H.264.

  Reset capabilities when changing servers or devices, select a supported transport for unavailable viewer choices, and keep WebRTC failures from falling back to locked HTTP streams. Only promise an insecure-HTTP MJPEG fallback when the backend supports it.

  Receive subsequent iOS connection config over the middleware's exec WebSocket. Reconnect input independently, preserving video and viewer codec choices when the config is unchanged; background discovery recovers changed session credentials when WebSockets are unavailable. Align the shared stream controls' HTTP fallback with the adapter's H.264 preference.

## 1.3.1

### Patch Changes

- a512bfe: Read the iOS foreground app icon from serve-sim's `/api/apps/icon` route when `/api` advertises `appIconEndpoint`, so a tunneled server shows the icon without the exec-ws socket. Older servers still get the icon over exec-ws.

## 1.3.0

### Minor Changes

- 39a07da: Add a `token` option to `useIosDeviceClient` for a serve-sim started with `--require-token`, such as an EAS Simulator Preview session.
- 04a0640: Send the `token` option from `useAndroidDeviceClient` too, and add it to `useActiveDeviceClient`, for a page that connects to a Hub started with `--require-token` from another origin. The Android client sends the token as a bearer header, as a `serve-emu.token.` WebSocket subprotocol, and as `?token=` only where a browser cannot set a header: the logcat and metrics `EventSource` streams, the camera image URLs, and the WebRTC close beacon. The WebRTC close POST sends the bearer header alone. The Hub does not allow other origins through CORS yet. So from another origin, this covers the Android H.264 stream and input socket, and the iOS client only from a loopback origin, without the features that use serve-sim's control socket.
- 91ecacb: Add DeviceClientProvider, useDeviceClient, useDeviceClientSelector, and useDeviceScreenClient so UI components can share one connection.

## 1.2.0

### Minor Changes

- 4e80b34: `DeviceClient.screenshot()` now resolves to a `ScreenshotCapture` with the PNG
  `blob` and its session `artifact` outcome, read from the backend's
  `X-Expo-Screenshot-Artifact` headers, instead of a bare `Blob`.

### Patch Changes

- fec1fc2: Request Android screenshots with POST.
- cb367df: Resolve proxied iOS stream, input, and middleware URLs against the configured public serve-sim mount.
- f68dd10: A failed iOS screenshot event in `events` now has the failure reason in its
  `message`, for example `Screenshot failed: simctl screenshot failed`.

## 1.1.0

### Minor Changes

- 255b36c: Initial release.

## 1.0.0

Placeholder release. It contains no code.
