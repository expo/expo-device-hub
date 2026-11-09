---
"expo-device-hub": patch
---

Retry the Android scrcpy server download up to 3 times on a temporary failure, and let `SERVE_EMU_SCRCPY_SERVER_URL` point the download at a mirror of the same file.
