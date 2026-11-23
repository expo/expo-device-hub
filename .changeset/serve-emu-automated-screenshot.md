---
"expo-device-hub": minor
---

Android screenshots accept `{ "automation": true }` to skip the session artifact, as serve-sim's do, so session previews do not appear as user screenshots. `GET /api` reports `screenshot.automation` so clients can check for support.
