---
"expo-device-hub": patch
"@expo/hub-client": patch
"@expo/hub-components": patch
"serve-emu": patch
---

Add device rotation support. A Rotate action in the stream controls More menu turns the device on both platforms: iOS cycles the simulator orientation over the serve-sim helper channel; Android locks the opposite orientation via the new serve-emu `/api/orientation` endpoint (`adb shell cmd window user-rotation`). serve-emu now runs scrcpy 4.0 and follows mid-stream video session changes, so touch input keeps working after rotation, and the phone frame rotates into landscape (short side capped at 480px) instead of shrinking into the portrait width.
