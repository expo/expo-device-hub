---
"@expo/serve-sim": patch
---

Skip WebRTC frames whose content did not change, and send each fresh frame when it arrives, up to 1.5 times the configured frame rate. The latest frame still repeats at the configured rate while the screen does not change.
