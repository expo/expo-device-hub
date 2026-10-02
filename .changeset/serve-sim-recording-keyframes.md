---
"@expo/serve-sim": patch
---

Session recordings now have at most a second between keyframes, instead of 2 seconds, so a browser player can seek to within a second. A still screen records about 8 MB a minute instead of 4.6; with motion, recordings grow by about 10%.
