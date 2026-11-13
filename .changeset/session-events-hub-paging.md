---
"expo-device-hub": patch
---

`/vendor/serve-emu/api/session` now honors `limit` and `before`, so `?limit=1` returns only the newest session event instead of the whole recording. A paged response carries the replay state at the top level and in `session`. A request without `limit` or `before` still returns the whole snapshot.
