---
"@expo/serve-sim": patch
---

Follow the active simulator display when capturing screenshots, and allow selecting a display by ID.
Do not retain unconfirmed screenshots after a display handoff fails, or replace a previous successful screenshot with failed-capture pixels.
Use the sole integrated screen when native selection is unavailable on a single-screen simulator. Reject known external display ports and keep native selection diagnostics in host logs.
