---
'expo-device-hub': minor
'@expo/hub-client': minor
---

Add `--require-token` to gate the iOS simulator routes behind a session token, printed in the dashboard link at startup. The dashboard reads the token from the link and `@expo/hub-client` accepts it as `accessToken`, presenting it as a bearer on fetches, as the `serve-sim.token.<token>` WebSocket subprotocol, and as `?token=` where the browser can set neither. iOS only: serve-emu has no token gate yet.
