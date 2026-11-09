---
"@expo/serve-sim": patch
---

Add an `automation` flag to screenshot captures so background session thumbnails do not count as user activity. Automated captures skip Desktop copies, and binary captures do not create manual screenshot artifacts.

The POST screenshot endpoint also accepts `automation: true` in its JSON body with the existing bearer token.
