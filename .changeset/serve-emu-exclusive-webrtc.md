---
"expo-device-hub": minor
---

serve-emu's `--transport webrtc` now makes WebRTC the only video transport, as serve-sim's does. A video WebSocket is refused with `stream_transport_locked` (HTTP 409 on the standalone server, close code 1008 through `createRouter`), the input-only `/ws?video=0` socket still works, and `/api` lists only `webrtc` in `viewerTransports.available`. The default `--transport websocket` still lets each viewer choose WebSocket or WebRTC.
