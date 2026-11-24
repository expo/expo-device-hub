---
"expo-device-hub": minor
"@expo/hub-client": minor
"expo-emulator-capture": minor
---

Add experimental emulator capture for Android emulators on macOS with Apple silicon. Turn it on with `--experimental-emulator-capture`, or with `EXPO_DEVICE_HUB_EXPERIMENTAL_EMULATOR_CAPTURE=1` for `expo start`. The Hub then installs the new `expo-emulator-capture` package, boots emulators with its agent and `-gpu host`, and streams them through the VideoToolbox hardware encoder as a new "Emulator capture" stream source, with scrcpy for input. It becomes the default source for emulators with the agent; other emulators use gRPC. The picture and touches follow rotation, and foldable emulators keep streaming when they fold or unfold. The stream source select shows the new source in every Hub, with the reason when it cannot be used. `@expo/hub-client` adds the `emulator-capture` source and the `unavailableModes` reasons.
