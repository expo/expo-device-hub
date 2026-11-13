---
"expo-device-hub": minor
---

Android: on an Apple silicon Mac that is not a virtual machine, the Hub now boots emulators with `-gpu host`, so they render on the Mac's GPU instead of a software renderer. Other hosts keep `-gpu auto`, and a `-gpu` in `EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS` still wins.
