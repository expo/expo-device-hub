---
"expo-device-hub": patch
---

serve-emu now omits scrcpy server options that already hold the server default, so the `app_process` command line stays under 255 bytes. Some Samsung devices, such as the Galaxy M22, abort the scrcpy server when the command line is longer, and the Hub listed them but never started their stream.
