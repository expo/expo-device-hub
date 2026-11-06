---
"@expo/serve-sim": patch
"expo-device-hub": patch
---

Validate native iOS Simulator capture callbacks against their dispatch queue instead of depending on Swift runtime executor checking mode.
