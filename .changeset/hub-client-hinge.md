---
"@expo/hub-client": minor
---

Add `client.hinge` for the iPhone Duo. It reads the hinge angle, pose, Table Mode and active display from serve-sim's screen config, and `setControl` sends a pose, angle, Table Mode or face up/down command. A hinge move that keeps the screen size now reaches the client. `HINGE_POSES`, `HingePose` and `HingeControlCommand` are exported.
