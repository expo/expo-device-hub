---
"@expo/serve-sim": minor
---

Add --install-app-path to install a local .app after boot and before any requested startup launch. Installation and --launch-app-identifier are independent, so callers can install without launching or install one app and launch another. Validate the app before touching a device, and report installation and validation failures as JSON under --quiet.
