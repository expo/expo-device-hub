---
"expo-device-hub": minor
---

Play an audio file into an Android emulator's microphone, so an app that records hears it. Use `POST /api/microphone/audio`, or `--mic-audio <path>` with `--mic-loop` on the serve-emu CLI. The audio flows while an app records; the first 2 s of the first recording are silent.
