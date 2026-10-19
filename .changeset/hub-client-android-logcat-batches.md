---
'@expo/hub-client': patch
'expo-device-hub': patch
---

Show Android logcat lines again. serve-emu sends logcat as batched `logs` events, and the Android client listened only for single-line `log` events, so no Android log reached the Hub since 0.8.0. The client now reads both.
