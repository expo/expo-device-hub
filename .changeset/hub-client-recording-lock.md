---
"@expo/hub-client": minor
"expo-device-hub": patch
---

Add `DeviceClient.recordingControlsLocked`. While an Android host recording is unknown, waiting, recording or finalizing, calls to `rotate`, `setOrientation`, `updateStreamSettings`, `setStreamSource`, `setGrpcImageMode`, `setGrpcEncoder` and `setGrpcInputSource` are silently ignored, because a rotation or stream change can end the recording. An orientation choice still waiting behind another request is dropped with `orientationError` when a recording starts. UIs can disable those controls from this one value. iOS never locks. The lock is temporary until recordings survive rotation and stream changes. `areRecordingControlsLocked` is deprecated in favor of `recordingControlsLocked`.

The Hub dashboard's Rotate button, stream options, and shut down and remove actions now follow the client's `recordingControlsLocked`. Rotate explains why it is unavailable only while it is locked.

Custom `DeviceClient` implementations and mocks must add `recordingControlsLocked`; clients without recordings use `false`.
