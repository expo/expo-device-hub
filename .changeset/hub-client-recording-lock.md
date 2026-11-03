---
"@expo/hub-client": minor
"expo-device-hub": patch
---

Add `recordingLock`, the reason a running Android recording locks rotation and stream changes, and `recordingControlsLocked`; calls to the locked controls are silently ignored meanwhile. `areRecordingControlsLocked` is deprecated in favor of `recordingLock`. Custom `DeviceClient` implementations and mocks must add these required members.
