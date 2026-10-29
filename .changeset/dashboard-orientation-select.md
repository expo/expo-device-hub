---
"expo-device-hub": minor
---

Add an Orientation select to Device options in the dashboard sidebar. It lists the poses the device accepts, shows a pick at once, then the pose the device reports, and shows why a change failed. It appears once the device reports a pose. The select and Rotate follow one rule: both are unavailable during an Android recording, while the recording status is unknown, and until the device stream is live.
