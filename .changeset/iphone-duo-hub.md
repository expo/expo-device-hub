---
"expo-device-hub": minor
"@expo/hub-client": minor
---

Add iPhone Duo support. The Hub recognizes a foldable simulator, shows its three everyday fold positions under the stream, and adds Fold pose, Hinge angle, Table Mode, and Preview mode controls to Device options. The default 3D preview renders Xcode's Duo model from serve-sim's `grid/api/devicekit-model` route, textured with both live panels and folding with the hinge; 2D shows the active display without a frame. `@expo/hub-client` exposes the hinge state and commands on `DeviceClient.hinge`, a `FoldableDeviceScreen` component, and the `duoPreview` connection option.
