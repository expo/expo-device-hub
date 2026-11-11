---
"expo-device-hub": minor
---

Add a Shake button to Device options for iOS simulators and Android emulators. A click shakes the device briefly, which opens the dev menu in Expo Go and in apps with expo-dev-menu. On Android, holding the button keeps the emulator shaking until you release it, as you shake a real phone; React Native's own dev menu opens after more than 2 s. serve-emu moves the emulator's virtual device through its physical model, so the accelerometer reads a real motion. The device in the stream wobbles while it shakes, unless the viewer prefers reduced motion, and each shake shows as Shake in Events on both platforms.
