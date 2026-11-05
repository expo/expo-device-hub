---
"expo-device-hub": minor
---

Allow foldable Android emulators to set hinge angles from 0 to 180 degrees through `/api/fold`, with device-range validation and confirmed readback. Fold status now includes the hinge range, and ambiguous rounded readings get time to settle before an angle write answers.
