---
'@expo/hub-client': patch
---

Report only the iOS stream modes that serve-sim advertises in `/api`: an HTTP server no longer offers WebRTC, and a WebRTC server no longer offers MJPEG or H.264.
