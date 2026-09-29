---
'@expo/serve-sim': minor
---

Save each `/api/screenshot` capture to `EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY`
when it is set, so the EAS session worker can upload it as a session artifact,
write a `.failed.json` record there when a save fails so the worker can report it,
and record every manual screenshot in the event log with its save outcome.
