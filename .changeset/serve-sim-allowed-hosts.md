---
"@expo/serve-sim": minor
"expo-device-hub": patch
---

An ungated preview now answers only for `localhost` and IP addresses. Other `Host` headers get 403, which stops a DNS rebinding page from reading the session token. Pass `--allow-any-host-when-insecure` (`allowAnyHostWhenInsecure` when embedding) to answer for any name; that is insecure without `--require-token`. Token-gated previews are unchanged.
