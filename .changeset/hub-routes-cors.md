---
"expo-device-hub": patch
---

`--cors-origin` now also covers the Hub's own routes, such as `/healthz`, `/readyz`, and `/api/devices`, with serve-sim's rule: a loopback page or a named origin may read them. The Hub answers their preflight before the token check, and their 401 and 500 responses carry the same headers. An unknown path under `/api/` or a backend mount now answers 404 with the same headers instead of falling through to the host.
