---
'@expo/hub-client': minor
---

Expose `DeviceClient.deviceSettingsStatus` so consumers can distinguish initial settings
loading from failed or timed-out reads. Bound Android settings reads to five seconds,
preserve successful values during background polling failures, and scope read status to
the selected device and credentials.
