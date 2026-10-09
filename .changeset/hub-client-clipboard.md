---
"@expo/hub-client": minor
---

Add text Paste and Copy for iOS simulators: `DeviceClient.pasteText`, `copyText`, `clipboardActionId`, `clipboardPending`, `clipboardError`, `clipboardWarning` and `capabilities.clipboard`. Keys typed after a Paste wait for it. `DeviceScreen` pastes the browser's text on Command+V when the helper supports Paste. HubClient and `DeviceScreen` do not show clipboard results; the host page shows `clipboardError` and `clipboardWarning`.

Desktop clients now keep the simulator's hardware keyboard connected, as serve-sim's own client does; only touch clients turn it off. iOS needs it for Command+V and Command+C.
