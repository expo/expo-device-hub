---
"expo-device-hub": minor
---

serve-emu reports the Android display's current pose as `orientation` in `GET /api` and `/health`, and `POST /api/orientation` accepts `portrait`, `landscape_left`, `portrait_upside_down` and `landscape_right`. The names match serve-sim's iOS poses: `landscape_left` has the bottom of the device on the left. Poses count from the device's natural display, so `portrait` and `landscape` now also turn devices that start wide, like tablets, and the answer's `orientation` reads `portrait` or `landscape` from that display. `landscape` still locks rotation 1 on a phone. The answer also reports the locked `pose`.
