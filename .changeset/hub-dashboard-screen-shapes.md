---
"@expo/hub-components": minor
"expo-device-hub": minor
---

Show each device in the screen shape of its model in the Hub dashboard, as on expo.dev: the corners of each iPhone, iPad, and Pixel 9 model, and the iPhone Duo display that the device shows, turned with the device. Unknown models keep the generic corners. The device frame artwork of the iPhone 17 Pro, the Pixel 9, and the Pixel 10 Pro is removed, and the inspector's "Show device frame" option is now "Show device shape": off, the screen is the plain video rectangle. The Hub server sends each device's `model` and no longer sends `deviceFrame`. `Device` and `NewDeviceRequest` take an optional `model`, and `PhoneFrame` and `StreamPanel` take `DeviceShape` from `@expo/hub-client/shapes` as an optional injected prop, so a consumer that does not pass it does not bundle the shapes. `showScreenShape` replaces `showDeviceFrame` and `deviceFrameAssets`, and the `deviceFrame*` exports and `NO_DEVICE_FRAME_DESCRIPTION` are removed.
