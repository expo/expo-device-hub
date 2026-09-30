---
"@expo/serve-sim": patch
---

Start the preview sooner: serve-sim now waits for the simulator boot once, and reads each launchd value once when it arms the capability loader. On a local simulator, the time to a ready preview goes from about 4.0 s to 2.3 s.
