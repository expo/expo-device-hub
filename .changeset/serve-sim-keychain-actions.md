---
"@expo/serve-sim": minor
---

Add `keychain.set`, `keychain.delete`, and `keychain.list` controls for iOS Simulator apps. Managed actions wait for setup and refuse requests after a setup failure until a retry succeeds; `keychain: false` refuses all three actions.
