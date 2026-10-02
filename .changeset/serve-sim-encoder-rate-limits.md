---
"@expo/serve-sim": patch
---

Hold the shared WebRTC H.264 encoder to its target bitrate over short windows, and send a keyframe to a viewer whose sender paused briefly once the one-second refusal limit ends. `/webrtc/stats` reports the pump's timer lateness, libwebrtc submit time, and `sharedCanvas.lowLatencyFallbacks`, the times the shared encoder fell back from low-latency to default rate control. The video frame rate menu offers 120 fps (the MJPEG menu stays at 60).
