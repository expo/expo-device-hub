---
"@expo/serve-sim": patch
---

Install simulator apps from EAS gzip tar archives, advertise archive support for local app-bundle uploads, and reject unsupported install files before invoking simctl.

Prepare archives in a bounded child process, validate complete link chains, and finish writes before cleanup. Keep extracted files private and reject non-regular install files. Use the CLI runtime for preparation, allow cleanup to use the remaining action budget, and prevent failed cleanup from accumulating extraction trees.
