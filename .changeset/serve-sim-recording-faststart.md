---
"@expo/serve-sim": patch
---

Optimize session recording MP4s for network playback so players can load the recording index before downloading the media. Keep the encoder-flush timeout from cancelling MP4 finalization, and report its duration in the recording log. Recording bitrate and resolution are unchanged.
