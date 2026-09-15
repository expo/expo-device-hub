---
'expo-device-hub': minor
---

Show the real launcher icon of the foreground app on Android. serve-emu gains
`GET /api/apps/icon`, which pulls the base APK and resolves the adaptive icon's
foreground bitmap with `aapt2`.
