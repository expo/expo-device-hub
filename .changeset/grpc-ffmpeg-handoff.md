---
'expo-device-hub': patch
---

Forward gRPC frames to FFmpeg as soon as its input is ready, with bounded backpressure and larger receive windows. Remove local RGB888 frame-write pacing and retry polling.
