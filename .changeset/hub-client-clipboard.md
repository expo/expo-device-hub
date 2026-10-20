---
"@expo/hub-client": minor
---

Add text Paste and Copy for iOS simulators: `DeviceClient.pasteText`, `copyText`, `clipboardActionId`, `clipboardAction`, `clipboardPending`, `clipboardError`, `clipboardWarning` and `capabilities.clipboard`. Keys typed after a Paste wait for it. `DeviceScreen` pastes the browser's text on Command+V when the helper supports Paste. It routes Command+C through an optional host `onCopy` callback when Copy is supported; without it, Command+C stays native keys. HubClient and `DeviceScreen` do not show clipboard results; the host page shows `clipboardError` and `clipboardWarning`.

Custom `DeviceClient` implementations and mocks must add these required members; unsupported clients use `capabilities.clipboard: false`, `clipboardActionId: 0`, null action/status fields, and methods that reject as unavailable.
