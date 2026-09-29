---
"@expo/serve-sim": patch
---

Skip WebRTC frames whose content did not change, so a simulator surface rewrite no longer takes the send slot of the next real frame.
