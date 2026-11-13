---
"expo-device-hub": patch
---

Show the Android launcher icon of apps whose adaptive icon bitmaps carry an API level in their resource config, such as `xxxhdpi-v26`. This affects apps with a minSdk below 26, for example Expo Go, which showed the placeholder icon before.
