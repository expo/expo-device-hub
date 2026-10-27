---
"@expo/hub-client": minor
---

Add `DeviceClient.setOrientation(orientation)` and `capabilities.orientation`, which lists the orientations it accepts, so a page can turn the device to one chosen pose. iOS accepts all four. Android accepts all four on serve-emu servers that report the display orientation, and portrait and `landscape_left` on older ones. Android requests go out one at a time, so the last choice wins.

On those Android servers `screen.orientation` now reports the display's pose, and the new `screen.framesUpright` tells `DeviceScreen` not to turn the already upright video.

Custom `DeviceClient` implementations and mocks must add `setOrientation` and `capabilities.orientation`; unsupported clients use `capabilities.orientation: false` and a no-op `setOrientation`.
