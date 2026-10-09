---
"expo-device-hub": patch
---

Under `--require-token`, the Hub's 401 for a missing token on a serve-sim or serve-emu route now carries that backend's CORS headers. A page that the backend allows, such as a `--cors-origin` page, can read the refusal instead of getting a network error.
