---
'@expo/serve-sim': minor
---

Save each `/api/screenshot` capture to `EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY`
when it is set, so the EAS session worker can upload it as a session artifact,
and record every manual screenshot in the event log with its save outcome.
