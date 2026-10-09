---
"expo-device-hub": minor
---

Add `--cors-origin <origin>` to let a page on another origin use the Hub with `@expo/hub-client`, on iOS and Android. It takes the same values as serve-sim's `--cors-origin`: an origin, or a subdomain wildcard such as `https://*.expo.dev`.
