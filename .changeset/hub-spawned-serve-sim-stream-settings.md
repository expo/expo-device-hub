---
"expo-device-hub": patch
---

The serve-sim helper that the Hub spawns for the iOS preview now gets the Hub's stream settings. With `--transport webrtc`, its own port refuses the MJPEG and H.264 HTTP streams, as the Hub does, instead of serving them without a token.
