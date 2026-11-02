---
"@expo/hub-client": minor
"expo-device-hub": patch
---

Add `recordingControlsLocked`, and while an Android recording runs, calls to the locked controls are silently ignored. `areRecordingControlsLocked` is deprecated in favor of `recordingControlsLocked`.
