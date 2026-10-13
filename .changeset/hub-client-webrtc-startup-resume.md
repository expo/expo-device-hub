---
"@expo/hub-client": patch
---

Pause WebRTC failure diagnosis while hidden and use session-scoped sender stats to distinguish missing media from codec failure. Resume paused video on both platforms and reattach replacement video elements without replacing the peer.
