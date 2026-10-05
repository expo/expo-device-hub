---
"expo-device-hub": minor
"@expo/hub-client": minor
---

Add iPhone Duo support. The Hub recognizes a foldable simulator and adds Fold pose, Hinge angle, Table Mode, and Preview mode controls to Device options. The default 3D preview renders Xcode's Duo model from serve-sim's `grid/api/devicekit-model` route, textured with both live panels and folding with the hinge; 2D shows the active display without a frame, clipped to that display's own glass corners from Xcode's DeviceKit profile, as the 3D model shows it head-on. `@expo/hub-client` exposes the hinge state and commands on `DeviceClient.hinge`, a `FoldableDeviceScreen` component, and the `duoPreview` connection option.

Match serve-sim's animated 2D sizing, allow reapplying the current fold pose, show pose shortcuts and unavailable Table Mode hints, and keep hinge errors visible below the stream. The 3D preview reports WebRTC statistics from the active panel and resets panel health after reconnects or missing frames. Shared WebRTC streaming advertises H.264 level 5.2, recovers stalled playback, and suspends first-frame checks while the tab is hidden.
