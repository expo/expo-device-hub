---
"@expo/serve-sim": patch
---

Follow each exec-ws binary screenshot with a `{id, screenshotMetadata}` JSON frame, with the same metadata as the HTTP `X-Expo-Screenshot-Metadata` header for that request. `actions.describe` advertises it with `binaryMetadataFrame: true` on the `output` property.
