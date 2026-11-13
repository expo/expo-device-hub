---
"expo-device-hub": patch
---

Android: one device that fails its check no longer hides the other devices. An emulator whose `adb emu avd name` fails, such as one connected over the network, now shows by its serial.
