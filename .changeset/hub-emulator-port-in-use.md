---
"expo-device-hub": patch
---

Android boots no longer reuse the console port of an emulator that is still booting or offline, and a boot that finds a different AVD on its allocated serial now fails, and stops the emulator it spawned, instead of returning that other emulator.
