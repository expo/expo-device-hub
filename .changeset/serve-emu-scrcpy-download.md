---
"expo-device-hub": patch
---

Try the Android scrcpy server download up to 3 times on a temporary failure, and let `SERVE_EMU_SCRCPY_BASE_URL` point the download at a mirror that keeps the GitHub release layout. If the mirror fails, the download falls back to GitHub.
