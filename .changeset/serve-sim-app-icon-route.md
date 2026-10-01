---
"@expo/serve-sim": minor
---

Add `GET {base}/api/apps/icon?bundleId=<id>`, which returns an installed app's icon as `{ok, bundleId, icon: {mimeType, data} | null}`, the same shape as serve-emu's route, with `bundleId` in place of `packageName`. `/api` advertises it as `appIconEndpoint`. A remote client behind a tunnel can read the icon with one request, and does not need the exec-ws socket.
