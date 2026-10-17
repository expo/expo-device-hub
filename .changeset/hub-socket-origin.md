---
"expo-device-hub": patch
---

The Hub's WebSockets now check the page's origin, with or without `--require-token`: a page on the Hub's own origin, or one that the route's CORS rule allows, may connect; any other page is closed with `1008 Origin not allowed`. A client that sends no `Origin`, such as a CLI, is not affected.
