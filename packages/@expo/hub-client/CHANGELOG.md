# @expo/hub-client

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
