---
"@expo/serve-sim": minor
"expo-device-hub": patch
---

A request that can change state (anything but GET, HEAD, and OPTIONS) from a browser page now needs the server's own origin or an origin named with `--cors-origin`, in serve-sim, the Hub, and serve-emu, with or without `--require-token`. Another site's page could send a form-like POST that needs no preflight, for example to shut down every simulator through a Hub without a token. A loopback page may still read, but needs `--cors-origin` to change state, as serve-emu and serve-sim's control socket already required. Requests without `Origin`, such as the CLI, are not affected.
