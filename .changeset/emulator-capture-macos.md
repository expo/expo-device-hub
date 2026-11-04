---
"expo-device-hub": minor
---

Add experimental GPU capture for Android emulators on macOS with Apple silicon. Set `EXPO_DEVICE_HUB_EXPERIMENTAL_EMULATOR_CAPTURE` to the path of the `expo-emulator-capture` agent library (built from this repository). The Hub then boots emulators with the agent and `-gpu host`, streams them through the VideoToolbox hardware encoder with scrcpy for input, and uses `scrcpy` as the default Android stream source. Foldable emulators keep streaming when they fold or unfold.
