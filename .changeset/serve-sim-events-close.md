---
"@expo/serve-sim": patch
---

Stop a stream route's watchers and timers when its client leaves before the first update. `/api/events` left a state watcher and a heartbeat running for the life of the server, and every later state change ran `simctl list` again for each one. `/ax`, `/metrics`, `/network-capture`, `/appstate`, `/logs`, and `/crashes` now also notice a client that left while they read the serve-sim state.
