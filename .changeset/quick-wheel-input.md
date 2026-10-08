---
"@expo/hub-client": patch
"@expo/serve-sim": patch
"expo-device-hub": patch
---

Keep simulator wheel scrolling responsive during trackpad and momentum bursts. Schedule idle touch-up outside the input queue, cancel it when touch input takes over, and combine wheel deltas per display frame after sending the first event immediately.
