---
"expo-device-hub": minor
---

serve-emu reports the Android display's current pose as `orientation` in `GET /api` and `/health`, and `POST /api/orientation` accepts `portrait`, `landscape_left`, `portrait_upside_down` and `landscape_right`. Poses count from the device's natural display, so `portrait` and `landscape` now also turn devices that start wide, like tablets.
