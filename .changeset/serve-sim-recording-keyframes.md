---
"@expo/serve-sim": patch
---

Session recordings now request keyframes every 60 submitted frames or one second of recording time, instead of 120 frames, reducing decoding work when seeking. Source pauses can leave longer gaps; the first resumed frame is a keyframe. A still screen records about 8 MB a minute instead of 4.6; with motion, recordings grow by about 10%.
