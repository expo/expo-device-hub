---
"@expo/hub-client": patch
"expo-device-hub": patch
---

Show the foreground app's name on Android. serve-emu now reads the label with
`aapt2 dump badging` from the APK it already pulls for the icon, and returns it as
`label` from `GET /api/apps/icon`. Before, it searched `dumpsys package` output,
which has no label, so the name was always missing. The Android client keeps the
label and the icon across foreground polls of the same build, reads them again
after a reinstall with a new version or build, and retries a failed read.
