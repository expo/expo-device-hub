---
'@expo/hub-client': patch
---

Report only the iOS stream modes that serve-sim advertises in `/api`: an HTTP server no longer offers WebRTC, and a WebRTC server no longer offers MJPEG or H.264.

Reset capabilities when changing servers or devices, select a supported transport for unavailable viewer choices, and keep WebRTC failures from falling back to locked HTTP streams. Only promise an insecure-HTTP MJPEG fallback when the backend supports it.

Receive subsequent iOS connection config over the middleware's exec WebSocket. Reconnect input independently, preserving video and viewer codec choices when the config is unchanged; background discovery recovers changed session credentials when WebSockets are unavailable. Align the shared stream controls' HTTP fallback with the adapter's H.264 preference.
