---
"@expo/serve-sim": patch
---

Stop reading and re-wiring a simulator's framebuffer while the simulator is not booted. A capture left open after a shutdown called into the dead simulator once a second, which leaked memory and, over days, CPU.
