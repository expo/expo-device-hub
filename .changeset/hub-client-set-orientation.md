---
"@expo/hub-client": minor
---

Add `setOrientation` and `capabilities.orientation` to turn a device to one pose, with `orientation`, `orientationPending` and `orientationError` showing the pick and then the backend's answer, `orientationUnavailable` giving the reason a change cannot go out now, and Android Rotate now steps through the same four poses as iOS. Custom `DeviceClient` implementations and mocks must add these required members.
