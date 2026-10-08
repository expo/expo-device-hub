---
'@expo/hub-client': patch
'expo-device-hub': patch
---

Report current device-settings availability independently of video, retain cached settings on failure, and recover iOS controls after connection interruptions. Discard interrupted reads, coalesce reconnect refreshes, and disable unavailable settings in the Hub dashboard.
