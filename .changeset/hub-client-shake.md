---
"@expo/hub-client": minor
---

Add `DeviceClient.shake()` and `capabilities.shake`. On iOS it uses serve-sim's shake input message. On an Android Emulator it calls serve-emu's `POST /api/shake`. The capability is false on older servers and on physical Android devices.
