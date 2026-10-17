---
"expo-device-hub": patch
---

Without `--require-token`, the Hub and serve-emu now answer only for `localhost`, `*.localhost`, and IP addresses, as serve-sim already did, and refuse other host names with 403 before any route or WebSocket. A page on another domain that resolves to the machine (DNS rebinding) counts as same-origin in the browser and could otherwise read the Hub and control devices. `--allow-any-host-when-insecure` turns the check off, in the Hub CLI and in serve-emu; under Expo CLI, set `EXPO_DEVICE_HUB_ALLOW_ANY_HOST=1`.
