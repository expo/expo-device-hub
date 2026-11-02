---
"@expo/hub-client": minor
---

Add `setOrientation` and `capabilities.orientation` to turn a device to one pose, with `orientation`, `orientationPending` and `orientationError` showing the pick and then the backend's answer, and Android Rotate now steps through the same four poses as iOS (`DEVICE_ORIENTATIONS`). On serve-emu, `screen.orientation` reports the pose the screen shows and `screen.framesUpright` keeps `DeviceScreen` from turning the video.

Custom `DeviceClient` implementations must add `setOrientation`, `orientation`, `orientationPending`, `orientationError` and `capabilities.orientation`.
