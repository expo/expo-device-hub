---
"expo-device-hub": minor
---

Add `--require-token` to the standalone CLI, the same flag as in serve-sim. The CLI mints a session token and prints links that carry it. The dashboard, the Hub API, the vendored serve-sim and serve-emu routes, and every WebSocket then need the token: a link trades it for an HttpOnly cookie, scripts send `Authorization: Bearer <token>`, and a page load without it shows a token form. `/readyz` stays open. `--frame-ancestor <origin>` lets another site frame the gated Hub. A Hub that listens on the network without the flag now prints a warning.
