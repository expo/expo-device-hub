---
"@expo/hub-client": minor
---

Add `DeviceClient.shake()`, `startShake()`, `stopShake()` and `capabilities.shake`. On iOS a shake uses serve-sim's shake input message, and a held shake sends one shake. On an Android Emulator they call serve-emu's `POST /api/shake`: `shake()` is a short shake, and a held shake renews its hold until `stopShake()`. The capability is false on older servers and on physical Android devices.
