---
"@expo/hub-client": patch
---

The iOS device client marks only the streamed simulator as `current` in `devices`. It marked every simulator with a running helper, so a consumer that names the current device could take another simulator's name.
