---
"expo-device-hub": patch
---

Stop the device list from hanging when CoreSimulatorService stops responding. `simctl` calls now time out after 30 s and report that the command did not respond.
