---
"@expo/hub-client": minor
---

Add a `token` option to `useIosDeviceClient` for a serve-sim started with `--require-token`, such as an EAS Simulator Preview session. The client sends the token as a bearer header and as a `serve-sim.token.` WebSocket subprotocol, and as `?token=` only where a browser cannot set a header: the MJPEG `<img>`, the app-state `EventSource`, and the WebRTC close URL. Without the option, requests are unchanged.
