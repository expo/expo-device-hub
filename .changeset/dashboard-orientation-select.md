---
"expo-device-hub": minor
---

Add an Orientation select to Device options in the dashboard sidebar. It lists the poses the device accepts, shows a pick at once, then the pose the device reports, and shows why a change failed. It appears once the device reports a pose, so it never appears on older serve-emu servers that report none. The select and Rotate follow one rule: both are unavailable during an Android recording and while the recording status is unknown, and on iOS until the simulator stream is live. Android turns over HTTP, so its controls do not wait for the stream.
