---
"@expo/serve-sim": patch
---

Report in-process recording shutdown deadline failures without interrupting pending MP4 finalization. Retain the process and device state until finalization completes, then clean up and exit with failure status.
