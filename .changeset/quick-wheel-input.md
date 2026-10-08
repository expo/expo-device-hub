---
"@expo/hub-client": patch
"@expo/serve-sim": patch
"expo-device-hub": patch
---

Combine browser wheel deltas per display frame after sending the first event immediately. Preserve scroll distance during trackpad and momentum bursts, and cancel buffered scrolling when touch input starts or the preview is cleaned up.
