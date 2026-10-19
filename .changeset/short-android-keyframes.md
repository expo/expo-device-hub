---
"expo-device-hub": patch
---

Shorten the default Android video keyframe interval from ten seconds to one second, giving decoders more frequent opportunities to recover after lost frames. Explicit keyframe interval overrides remain supported.
