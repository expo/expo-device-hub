---
"expo-device-hub": minor
---

Add a Network section to the dashboard sidebar that lists the selected device's app requests (method, status, path, time, size) with their headers, request body, and response body on demand. The Hub reads them from the app's React Native inspector through the Metro server it runs in, so it works the same on iOS simulators and Android emulators without a proxy. Credential header values are redacted with serve-sim's capture rules. The standalone CLI reads them from the Metro server named by `EXPO_DEVICE_HUB_METRO_URL`.
