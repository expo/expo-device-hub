---
"@expo/hub-client": patch
---

Offer only the Android stream modes that serve-emu lists in `/api` `viewerTransports.available`. On a `--transport webrtc` host, H.264 is not offered and an H.264 choice falls back to WebRTC. Older serve-emu versions without the list keep the WebSocket video.
