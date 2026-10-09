---
"expo-device-hub": minor
---

The CLI now records each running Hub in `server-<port>.json` in `$TMPDIR/expo-device-hub` (or `EXPO_DEVICE_HUB_STATE_DIR`), with the session token under `--require-token`, as serve-sim records its helpers. A program that starts the Hub, such as the EAS worker, can read the token there.
