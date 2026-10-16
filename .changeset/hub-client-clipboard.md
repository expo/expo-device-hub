---
"@expo/hub-client": minor
---

Add text Paste and Copy for iOS simulators: `DeviceClient.pasteText`, `copyText`, `clipboardActionId`, `clipboardAction`, `clipboardPending`, `clipboardError`, `clipboardWarning` and `capabilities.clipboard`. Keys typed after a Paste wait for it. `DeviceScreen` pastes the browser's text on Command+V when the helper supports Paste. HubClient and `DeviceScreen` do not show clipboard results; the host page shows `clipboardError` and `clipboardWarning`.
