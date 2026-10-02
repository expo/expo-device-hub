---
'expo-device-hub': patch
---

Stream physical Android devices over scrcpy instead of inheriting the emulator-only `grpc-screenshot` default, and stop broadcasting `video-session` for scrcpy restarts that keep the same size, which sent WebCodecs viewers into a keyframe-reset loop.
