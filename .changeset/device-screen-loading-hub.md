---
"expo-device-hub": minor
---

Show one spinner while a device screen loads, on the device's own surface instead of a black screen, for iOS and Android and for the iPhone Duo's 2D and 3D previews. The status pill says "Loading" until the screen, or the 3D model with its first display frame, appears. A stream that drops after it loaded keeps its last frame and shows "Reconnecting" without a spinner. Stream errors appear as one notice over the screen, also over the 3D preview. A 3D model that does not load in 30 seconds while the tab is visible falls back to the flat screen until you select 3D again or switch the device.
