---
'expo-device-hub': minor
'@expo/hub-client': minor
---

Add a Folded switch to the Android device options for foldable emulators. It folds or unfolds the emulator fully through serve-emu's `/api/fold`, follows posture changes made elsewhere, and notes when the device is half open, flipped, or in tent posture. The `fold` device setting reports the posture, or `unsupported` on a device without a hinge.
