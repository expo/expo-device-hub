---
'expo-device-hub': minor
'@expo/hub-client': minor
---

Add `--require-token` to gate iOS simulator routes and device lifecycle actions behind a session token. `@expo/hub-client` accepts an `accessToken` option to authenticate iOS connections. Authenticated links are saved in a private file. Android streaming and control are not gated yet.
