---
'expo-device-hub': minor
---

Persist preview screenshots for EAS artifact upload when
`EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY` is set. The change ships through the
vendored serve-emu and serve-sim builds, a failed save writes a
`.failed.json` record for the EAS worker to report, and on iOS each manual screenshot and
any failed save appear as session events.
