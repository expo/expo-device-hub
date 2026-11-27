---
"expo-device-hub": minor
---

Android screenshots take an optional `{"automation": true}` JSON body, as iOS screenshots do. An automated capture returns the same image and metadata but does not save a session artifact. `GET /api/screenshot` on serve-emu lists the supported options, so a client can check for automation before its first capture.
