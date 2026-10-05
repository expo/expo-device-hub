---
"@expo/hub-client": patch
---

`DeviceClientProvider` no longer publishes a client whose values are all unchanged. Before, a parent render of the provider could render every subscribed component a second time.
