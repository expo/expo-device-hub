---
"@expo/hub-client": patch
"@expo/serve-sim": patch
"expo-device-hub": patch
---

Combine browser wheel deltas per display frame after sending the first event immediately, and cancel buffered scrolling when touch input starts, the page becomes hidden, or the preview is cleaned up. Requires a simulator host that buffers excess wheel distance across screen-edge reanchors.
