---
"@expo/serve-sim": patch
"expo-device-hub": patch
---

Avoid Darwin filesystem metadata lookups when discovering TCP listeners, so unrelated mounts do not delay port reclamation when starting a server.
