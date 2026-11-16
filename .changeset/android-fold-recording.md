---
"expo-device-hub": minor
"@expo/hub-client": minor
---

Android screen recordings of a foldable emulator now survive folding and unfolding. With gRPC capture, the Hub records a foldable on one fixed canvas that fits both displays and centers the shown display on it. `session.json` then has a `deviceStates` timeline, in the format of serve-sim's iPhone Duo recordings: at each change, the display (`inner` or `outer`), its native size, its place on the canvas (`contentRect`), the hinge angle, and the UI `orientation`. The hinge is read over the emulator's gRPC controller every 100 ms and at once when the emulator reports a posture change, and the recording has a keyframe at least once a second, as serve-sim's recordings. The recording status from `/api` has `followsFold: true` for such a recording, and `POST /api/fold` answers 409 while a recording that cannot follow a fold runs. In hub-client, `DeviceFold` has an optional `unavailable` reason. On Android, it is the recording lock only while the recording does not follow folds, so fold commands and the Hub's Fold settings stay available during a recording that does. Rotation and stream changes stay locked while a recording runs.
