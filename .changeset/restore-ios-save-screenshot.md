---
"expo-device-hub": patch
---

Restore the iOS Save screenshot action. serve-sim's `/api/screenshot` route was lost in its fetch-style middleware rewrite, so the dashboard's Save button silently did nothing for simulators.
