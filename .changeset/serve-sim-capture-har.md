---
"@expo/serve-sim": minor
---

Export network capture as HAR. The tools panel downloads the session HAR, `{base}/network-capture.har` and `{base}/network-capture.ndjson` serve it, and `serve-sim capture har -o <path>` keeps a separate recording that starts with the session's earlier requests and continues through capture restarts. A recording that already holds requests is replaced only with `--force`.
