---
"@expo/serve-sim": patch
---

Keep the preview server's own port in a device's state when a device is started through a tunnel, whose Host header carries no port. The state no longer points at port 0, so metrics and recording reach a second device.
