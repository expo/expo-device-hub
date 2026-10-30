---
"@expo/serve-sim": patch
---

Fix about three seconds of lag in the HTTP simulator preview on Chromium. When the encoder falls back to default rate control, the stream now declares that frames are never reordered.
