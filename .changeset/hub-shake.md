---
"expo-device-hub": minor
---

Add a Shake button to Device options for iOS simulators and Android emulators. Each shake also wobbles the device in the stream once, unless the viewer prefers reduced motion. On Android, serve-emu sends a short accelerometer burst that opens the Expo Go and expo-dev-menu dev menu. React Native's own Android shake detector needs a longer shake, so a bare React Native app without expo-dev-menu does not react to it.
