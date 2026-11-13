---
"expo-device-hub": minor
"@expo/hub-client": minor
"expo-emulator-capture": minor
---

Android recordings of an emulator that runs the emulator capture agent now have their own encode, apart from the live stream. The agent serves a stream consumer and a recording consumer at once (protocol 3, with the new `U` role and `C` canvas commands) and copies each frame once for both. The recording uses the emulator's native resolution, the display's refresh rate (`hw.lcd.vsync`, at most 120) and 8 Mbit/s, in the panel orientation on one fixed canvas, with a keyframe at least once a second. `EXPO_DEVICE_HUB_RECORDING_MAX_DIMENSION`, `EXPO_DEVICE_HUB_RECORDING_FPS` and `EXPO_DEVICE_HUB_RECORDING_BITRATE` change that at the start. Stream settings, the stream source, viewers, rotations, folds and the device options no longer end such a recording: the recording status reports `independent: true`, and `recordingLock` in `@expo/hub-client` is null for it, so the Hub keeps every control available. `session.json` has a `deviceStates` timeline with the orientation of each part. When the emulator shuts down, the recording finishes at once with `stopReason: "device-ended"`, and the stop request publishes it. Without the agent, the recording and its lock work as before. `expo-emulator-capture record` adds `--role recording` and `--canvas`.
