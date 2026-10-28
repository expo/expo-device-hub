---
"expo-device-hub": patch
---

Android: wait for a device to finish booting before starting its stream. adb lists an emulator seconds before Android starts its system services, so a session started in that window failed (scrcpy's input `NullPointerException`, or "could not wakeup … Can't find service: power") and the Hub answered every request with "cooling down after a failure" until a retry succeeded.
