---
"@expo/hub-client": patch
"expo-device-hub": patch
---

Expose WebRTC playback state and an immediate resume action so consumers can present recovery before the first frame. Device Hub shows recovery above flat and Duo previews when autoplay is blocked, without sending device input.

Consumers that render `DeviceScreen` directly must use `usePlaybackRecovery(client)` and present recovery outside hidden or inert media wrappers. `DeviceScreen` does not render playback notices.
