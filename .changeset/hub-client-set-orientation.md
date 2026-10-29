---
"@expo/hub-client": minor
---

Add `DeviceClient.setOrientation(orientation)` and `capabilities.orientation`, which lists the orientations it accepts, so a page can turn the device to one chosen pose. `orientation`, `orientationPending` and `orientationError` show the choice at once, then the backend's answer or failure, like `appearance` and `location`. iOS accepts all four poses. Android accepts all four on serve-emu servers that report the display orientation, and `portrait` and `landscape_right` on older ones. Android requests go out one at a time, so the last choice wins, and Rotate on those servers steps through the same four poses as iOS. `DEVICE_ORIENTATIONS` exports that order.

On those Android servers `screen.orientation` now reports the display's pose while it agrees with the frame, and the new `screen.framesUpright` tells `DeviceScreen` not to turn the already upright video.

Custom `DeviceClient` implementations and mocks must add `setOrientation`, `orientation`, `orientationPending`, `orientationError` and `capabilities.orientation`; unsupported clients use `capabilities.orientation: false`, `orientation: null` and a no-op `setOrientation`.
