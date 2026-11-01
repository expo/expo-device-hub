---
"expo-device-hub": patch
---

Android boots no longer reuse the console port of an emulator that is still booting or offline, and a boot that lands on another emulator's port now fails at once instead of returning that other emulator.
