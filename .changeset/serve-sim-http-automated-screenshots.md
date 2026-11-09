---
"@expo/serve-sim": patch
---

Add an `automation` query to `POST /api/screenshot`. With the session bearer token, `?automation=true` returns the PNG without an activity event or a manual screenshot artifact, and the response confirms it with `X-Expo-Screenshot-Automation: applied`.
