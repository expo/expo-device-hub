---
"@expo/hub-client": patch
"expo-device-hub": patch
---

Wait for helper admission before sending iOS input when the helper advertises `inputAdmission`. Legacy helpers continue accepting input when the socket opens.
