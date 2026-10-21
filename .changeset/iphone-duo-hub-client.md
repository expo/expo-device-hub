---
"@expo/hub-client": minor
---

Add foldable device support, starting with the iPhone Duo. `DeviceClient.fold` reports the fold state (hinge angle, named pose, Table Mode, and how the device is held) and takes fold commands. `capabilities.fold` lists the commands that a device accepts, and `FOLD_POSES` names the poses that all foldables share. `fold.observe` reports each command from its request to its outcome. `DeviceClient.displays` streams each display (`cover`, `inner`) into an element that you attach, with the transport, codec fallback, and session token of the flat stream. Touch, multi-touch, and scroll samples can address one display, and `screen.display` names the display that the screen describes. `DeviceClient.deviceModelUrl` points to a 3D model of the device, Xcode's for the iPhone Duo. `useDeviceKeyboard` and `listenForInputCancellation` give your own device surface the keyboard and input-release handling of `DeviceScreen`.
