---
"expo-device-hub": patch
---

Fix about three seconds of lag in the iOS Simulator preview on Chromium. The vendored serve-sim stream now declares that frames are never reordered after its encoder falls back to default rate control.
