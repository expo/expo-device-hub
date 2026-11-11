---
"expo-device-hub": patch
---

Return screenshot metadata from serve-emu responses. The rotation is read right before and right after each capture and is reported only when both readings agree with each other and the image, with no Hub rotation command between them; width and height come from the PNG.
