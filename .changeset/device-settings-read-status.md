---
'@expo/hub-client': minor
---

Expose `DeviceClient.deviceSettingsStatus` so consumers can distinguish initial settings
loading from failed, invalid or timed-out reads. Use a shared read-status lifecycle for
iOS and Android, bound Android reads to five seconds, and scope status to the selected
device and credentials. Preserve successful values during background refresh failures
and retry the complete Android settings list after an initial failure. Preserve the
settings object reference when Android polling makes no effective value changes.
