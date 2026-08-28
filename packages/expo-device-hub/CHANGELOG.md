# expo-device-hub

## 0.7.0

### Minor Changes

- 09ec254: Add a `--hide-boot-device` CLI option that hides controls for booting and creating devices.

### Patch Changes

- 5065b02: Show a compact stream-status pill above the device frame and reveal its identifier on click.

## 0.6.0

### Minor Changes

- ce7fec2: Add Android network and font-size controls to the shared device options UI.
- b1e9c36: Add Android WebRTC streaming

### Patch Changes

- bf38c74: Send iOS screenshot requests with POST to match the updated serve-sim endpoint.

## 0.5.0

### Minor Changes

- 9897a47: Add agentic cursor visuals for argent
- 2ef9430: Add device options, activity graphs, device events, stream controls, and collapsible log sections for iOS sessions.
- 14be971: Add `--hide-sidebar` to the standalone CLI.
- be2b818: Add standalone CLI flags for configuring serve-sim streaming, WebRTC ICE, and metrics CORS.
  Expose EAS-compatible readiness and temporary serve-sim-backed metrics endpoints.

## 0.4.0

### Minor Changes

- 1e21217: Add `--platform ios|android` to the standalone CLI.
- d906816: Add keyboard input and simulator keyboard controls.
- 571207b: Add H.264, and WebRTC iOS simulator streaming.
- e106f9b: Add `--transport mjpeg|h264|webrtc` to the standalone CLI.

## 0.3.0

### Minor Changes

- d5c3290: Added UI to create new simulators and emulators based on the available SDKs.
- f7f6486: Add currently opened application metadata.
- b6d3b9f: Added fullscreen compact view to maximize the device view when used in agentic UIs.

### Patch Changes

- 93a310a, 9282d67: Fixed reading of the last boot timestamp of recent simulators and emulators.

## 0.2.1

### Patch Changes

- f32c4e3: Restore the iOS Save screenshot action. serve-sim's `/api/screenshot` route was lost in its fetch-style middleware rewrite, so the dashboard's Save button silently did nothing for simulators.

## 0.2.0

### Minor Changes

- ce37414: Add a standalone CLI (`npx expo-device-hub`) that serves the Hub dashboard.

### Patch Changes

- 5a98e6d: Add resizable sidebars. Drag the vertical seam between either sidebar.
- 85599c2: Add device rotation support. A Rotate action in the stream controls More menu.

## 0.1.1

### Patch Changes

- 28f3787: Performance and design updates.

## 0.1.0

### Minor Changes

- 4c8cdd7: Initial release
