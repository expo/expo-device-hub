---
'@expo/hub-client': patch
'expo-device-hub': patch
---

`deviceSettingsStatus` now reports iOS discovery, connection loss, and recovery, so consumers no longer need the video status. Failed refreshes report `'error'` and keep cached settings. The Hub dashboard disables unavailable settings.
