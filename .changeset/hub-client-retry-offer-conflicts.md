---
"@expo/hub-client": patch
"expo-device-hub": patch
---

Retry temporary Android WebRTC offer conflicts when capture or the device session changes during setup.

Refuse standalone Android WebRTC offers for a selected device that is no longer active, so recovery cannot connect to a different device.
