---
"expo-device-hub": minor
---

Android session events now record every user and API interaction, so EAS can count it as activity. The preview's Reload button, screenshots, rotation, fold, device settings, app and file actions, route playback controls, and camera images now appear in `/vendor/serve-emu/api/session`. Input sent with `record: false` and the new `action` entries carry `replay: false`, and session replay skips them, so a replay still sends only the recorded input.
