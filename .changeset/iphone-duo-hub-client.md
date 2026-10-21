---
"@expo/hub-client": minor
---

Add iPhone Duo support. `DeviceClient.hinge` reports the fold state and takes hinge commands, and `hinge.observe` reports each command from its request to its outcome. `DeviceClient.displays` streams each display into an element that you attach, with the transport, codec fallback, and session token of the flat stream. Touch, multi-touch, and scroll samples can address one display. `DeviceClient.deviceModelUrl` points to Xcode's 3D model of the device. `useDeviceKeyboard` and `listenForInputCancellation` give your own device surface the keyboard and input-release handling of `DeviceScreen`.
