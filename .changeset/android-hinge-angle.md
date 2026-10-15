---
'expo-device-hub': minor
---

Let serve-emu move a foldable Android emulator's hinge to an angle from 0 to 180 degrees with `POST /api/fold` and `{ "hingeAngle": number }`, the same range serve-sim accepts for the iPhone Duo. The response reports the posture Android derives from the new angle. Every fold status also reports the emulator's `hingeRange`, and serve-emu refuses an angle outside it, such as 90 degrees on a fold-out hinge that moves from 180 to 360 degrees.
