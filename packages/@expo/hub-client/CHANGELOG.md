# @expo/hub-client

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
