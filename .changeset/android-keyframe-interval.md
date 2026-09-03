---
'expo-device-hub': patch
---

Ask the Android encoder for a keyframe every 10 seconds instead of every second. Late joiners still get one on demand, and the stream no longer carries a per-second burst.
