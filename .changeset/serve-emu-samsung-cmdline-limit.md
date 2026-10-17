---
"expo-device-hub": patch
---

serve-emu now omits scrcpy server options that already hold the server default. With the Hub's default stream settings, the `app_process` command line drops from 344 to 198 bytes. Some Samsung devices, such as the Galaxy M22, abort the scrcpy server when the command line exceeds about 255 bytes, and the Hub listed them but never started their stream. Custom serve-emu settings, such as `--repeat-frame-ms` with a non-default bitrate, can still exceed that length.
