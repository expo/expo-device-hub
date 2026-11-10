---
"@expo/serve-sim": minor
---

Add `serve-sim shake` and the `shake` exec-ws action. They shake the simulator like Simulator.app's Device → Shake, so the foreground app gets a shake motion event. Helpers that support it advertise `inputShake: true`, and the preview toolbar then shows a Shake button.
