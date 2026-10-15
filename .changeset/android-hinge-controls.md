---
'@expo/hub-client': minor
'expo-device-hub': minor
---

Show the Hub's fold controls for foldable Android emulators. The Android client now reports `hinge`, so Device options offer the same Fold pose and Hinge angle settings as the iPhone Duo, limited to Fully folded, Partially open, and Fully open. Emulators whose hinge does not move from 0 to 180 degrees, such as fold-out profiles, get no fold controls. `DeviceHinge.controls` tells consumers which poses, Table Mode, and 3D model a hinge offers.
