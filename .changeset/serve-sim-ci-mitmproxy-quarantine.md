---
"@expo/serve-sim": patch
---

Take the mitmproxy cask out of quarantine in the serve-sim CI tests, because Gatekeeper rejects mitmproxy 12.2.3 and its quarantined first launch never returns.
