---
"expo-device-hub": minor
---

serve-emu's `POST /api/orientation` now also accepts `portrait`, `landscape_left`, `portrait_upside_down` and `landscape_right`, counted from the natural display so tablets are named right, and returns the locked `pose`; `landscape` stays as an alias for `landscape_right`. `GET /api` and `/health` now report the shown pose as `pose`.
