---
"expo-device-hub": patch
---

Route `POST /_eas/android-recording/stop` only in the standalone CLI. The DevTools plugin in `expo start` never starts an Android recording, so it no longer serves the stop route or reads `EXPO_DEVICE_HUB_RECORDING_CONTROL_TOKEN`.
