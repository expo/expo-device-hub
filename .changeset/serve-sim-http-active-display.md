---
"@expo/serve-sim": patch
---

Make tunneled and dashboard screenshot downloads follow the active Duo panel, with an optional explicit display query. Single-display devices can fall back to simctl when native capture is unavailable.

Add troubleshooting guidance when CoreDevice cannot find a simulator, including how to check for a stale service after an Xcode update.
