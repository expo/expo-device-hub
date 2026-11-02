---
"@expo/hub-client": minor
"expo-device-hub": patch
---

Add `recordingControlsLocked`, which is true while an Android recording could break. Meanwhile Rotate, `setOrientation` and the stream setters are ignored, also Rotate before the first recording status arrives, and the Hub disables Rotate, the stream options and shut down and remove from this value. `areRecordingControlsLocked` is deprecated.

Custom `DeviceClient` implementations must add `recordingControlsLocked`.
