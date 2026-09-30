---
"@expo/serve-sim": patch
"expo-device-hub": patch
---

`simMiddleware` now throws on an empty `execToken`. Before, the exec channel accepted an empty `token` frame from any client. Under `requirePreviewToken`, it also throws on an `execToken` with characters other than letters, digits, and `-._~`, because a client cannot send such a token in every place the gate reads it. The Hub refuses a session token outside the same set. Tokens that serve-sim and the Hub generate already qualify.
