---
"@expo/serve-sim": patch
---

Start the preview sooner: serve-sim now waits for the simulator boot once, and reads each launchd value once when it arms the capability loader. On an EAS macOS worker, the median time to a ready preview went from 2.6 s to 1.6 s.
