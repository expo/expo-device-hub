---
'@expo/hub-client': minor
---

`DeviceClient.screenshot()` now resolves to a `ScreenshotCapture` with the PNG
`blob` and its session `artifact` outcome, read from the backend's
`X-Expo-Screenshot-Artifact` headers, instead of a bare `Blob`.
