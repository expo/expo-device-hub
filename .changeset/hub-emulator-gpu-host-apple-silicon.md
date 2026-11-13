---
"expo-device-hub": minor
---

Android: on an Apple silicon Mac that is not a virtual machine, the Hub now boots emulators with `-gpu host`, so they render on the Mac's GPU instead of a software renderer. Other hosts keep `-gpu auto`, and a `-gpu` in `EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS` still wins. On such a Mac, the "Live" status of an emulator that renders on the CPU shows in the warning color with an info icon, and opens details on how to get 60 FPS. Stream options now shows whether an Android device renders on the CPU or the GPU.
