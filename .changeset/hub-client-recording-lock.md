---
"@expo/hub-client": minor
---

Add `DeviceClient.recordingControlsLocked`. While an Android host recording is unknown, waiting, recording or finalizing, `rotate`, `setOrientation`, `updateStreamSettings`, `setStreamSource`, `setGrpcImageMode`, `setGrpcEncoder` and `setGrpcInputSource` do nothing, so the recording is not cut by an encoder restart. UIs can disable those controls from this one value. iOS never locks. The lock is temporary until recordings survive rotation and stream changes.

Custom `DeviceClient` implementations and mocks must add `recordingControlsLocked`; clients without recordings use `false`.
