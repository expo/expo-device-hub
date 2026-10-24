---
"@expo/hub-client": patch
"expo-device-hub": patch
---

Add iOS permission controls to Device Hub with service-backed status after reload and reconnect. Keep controls pending until readback confirms changes, including when switching apps during a reset.

Clear stale permission labels when the helper changes, and scope pending operations to the host, Simulator and app.
