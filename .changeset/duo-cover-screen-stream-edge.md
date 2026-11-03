---
"@expo/serve-sim": patch
"@expo/hub-client": patch
"expo-device-hub": patch
---

Show the whole iPhone Duo cover screen in the 2D WebRTC stream. The picture was stretched and its right edge was cut, which showed as a dark stripe. serve-sim now draws it from the top-left corner of the shared canvas, with black bars right after the picture, and the screen views pin the frame to the top-left.
