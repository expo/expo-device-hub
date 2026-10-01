---
"@expo/serve-sim": patch
---

Hold the shared WebRTC H.264 encoder to its target bitrate over short windows, and send a keyframe to a viewer whose sender paused briefly once the one-second refusal limit ends. `/webrtc/stats` reports the pump's timer lateness and libwebrtc submit time, and the video frame rate menu offers 120 fps (the MJPEG menu stays at 60).
