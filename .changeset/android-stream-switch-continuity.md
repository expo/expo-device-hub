---
'expo-device-hub': patch
---

Keep the Android device frame on its last frame while the stream source (scrcpy ↔ gRPC) or gRPC image mode (PNG ↔ MMAP) switches, instead of flashing a black "Disconnected" overlay; reconnect immediately after serve-emu's deliberate socket close, report the gap as "Reconnecting" for a short grace period, and keep the sidebar source controls pending (with a "Switching stream source…" hint) until the replacement stream is actually on screen so the controls and the frame change together.
