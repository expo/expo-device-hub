---
'expo-device-hub': patch
---

Keep RGB888 video current when its source produces frames faster than the configured video FPS. Drain gRPC responses continuously and submit the newest image at the encoder's configured rate instead of pacing reception.
