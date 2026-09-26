---
"@expo/serve-sim": minor
"expo-device-hub": minor
---

Add network capture for iOS simulators. `--network-capture` records HTTP(S) traffic from third-party apps through a local mitmproxy, metadata only by default; `--network-capture-field` opts into headers, query values, and bodies, with credential headers redacted. Capture requires mitmproxy, and on a host reachable beyond loopback it requires `--require-token`.
