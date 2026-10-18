---
"expo-device-hub": patch
---

Android screenshots of a foldable emulator are valid PNGs of the screen in use. Before, `screencap` added a warning in front of the image and captured the inner display, which is off while the device is folded.
