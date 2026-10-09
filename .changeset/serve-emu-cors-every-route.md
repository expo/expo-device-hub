---
"expo-device-hub": patch
---

serve-emu now answers every route with its CORS policy and answers every preflight, as serve-sim does. A page on a loopback origin can use the Android backend of a Hub on a loopback address, and an allowed cross-origin page can read the screenshot artifact headers. `allowedOrigins` also takes serve-sim's subdomain wildcard, such as `https://*.expo.dev`.
