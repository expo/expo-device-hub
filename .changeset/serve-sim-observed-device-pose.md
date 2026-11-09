---
"@expo/serve-sim": patch
---

Expose independently observed device pose and screen orientation for Simulator clients. Keep legacy orientation behavior for older clients, and avoid pose observation for temporary screenshots. Limit the new ordinary-device observer to single-display iOS runtimes.
