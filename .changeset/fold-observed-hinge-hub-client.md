---
"@expo/hub-client": patch
---

On the iPhone Duo, a fold change that you request now holds in `client.fold` until the simulator reports it, or for at most 500 ms after the command's config, so the fold does not jump back while the simulator catches up. The `confirmed` fold event has `observed: false` when that limit ran out first. An observed angle within 1° of a preset now names that preset.
