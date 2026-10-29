---
"@expo/hub-client": minor
---

Add `client.hinge` for the iPhone Duo. It reads the hinge angle, pose, Table Mode, whether Table Mode is available, whether face up/down commands are supported, and the active display from serve-sim's screen config, and `setControl` sends a pose, angle, Table Mode or face up/down command. A hinge move that keeps the screen size now reaches the client. The new exports are `HINGE_POSES` and the types `DeviceHinge`, `HingeControlCommand`, `HingePhysicalOrientation`, `HingePose` and `ObservedHingeState`. `ScreenSize` gains optional hinge fields from serve-sim's screen config.
