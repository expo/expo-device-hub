---
"expo-device-hub": minor
---

Add a Share button to the toolbar under the device. It copies a link to the Hub, as serve-sim's Share button does. On a Hub started with `--require-token`, the link carries the session token, and the tooltip says so. `--share-url <url>` makes it copy another page instead. When the browser refuses the copy, a panel shows the link to copy by hand.
