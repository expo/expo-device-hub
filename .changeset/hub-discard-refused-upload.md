---
"expo-device-hub": patch
---

The Hub now discards an upload that it answers without reading, such as one the token gate refuses or one whose route fails. Before, a large refused POST stayed paused, and the next request on the same keep-alive connection waited forever.
