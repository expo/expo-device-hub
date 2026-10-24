---
"@expo/serve-sim": patch
"expo-device-hub": patch
---

Fix Simulator permission commands to read and update native service state. Notification grants, denials and resets can take effect while the app is running; some other app frameworks still cache authorization until relaunch.

Fix permission reads failing during brief Simulator database locks.
