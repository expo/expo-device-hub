---
"@expo/hub-components": minor
"expo-device-hub": minor
---

Show each device in the screen shape of its model in the Hub dashboard, as on expo.dev, when no frame artwork shows: the corners of each iPhone, iPad, and Pixel 9 model, and the iPhone Duo display that the device shows, turned with the device. The Hub server now sends each device's `model`, and `PhoneFrame` and `StreamPanel` take `DeviceShape` from `@expo/hub-client/shapes` as an optional injected prop, so a consumer that does not pass it does not bundle the shapes. Unknown models keep the generic corners.
