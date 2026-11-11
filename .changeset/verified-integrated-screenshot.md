---
"@expo/serve-sim": patch
"expo-device-hub": patch
---

Capture default Simulator screenshots, including resized and JPEG requests, without starting video when the device profile and runtime enumeration verify one usable display. Keep native display selection when the evidence is missing, ambiguous, or conflicting. Reuse native capture for existing sessions, including sessions created during display verification.
