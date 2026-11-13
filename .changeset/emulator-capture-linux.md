---
"expo-device-hub": minor
"expo-emulator-capture": minor
---

Add experimental emulator capture on Linux x86-64. The agent reads each frame back from the renderer on a capture thread, one post later, so the emulator's render thread does not wait for the read, and encodes it with the system's x264 build 165 (Ubuntu 26.04: `sudo apt install libx264-165`), turned upright for the display rotation. With `--experimental-emulator-capture`, the Hub on Linux boots emulators with the agent and `-gpu lavapipe`. When x264 build 165 is missing, the Hub boots emulators without the agent and the stream source select says what to install. `expo-emulator-capture` adds the Linux agent and a `build:linux-x64` task, and its README shows how to start an emulator with the agent on EAS.
