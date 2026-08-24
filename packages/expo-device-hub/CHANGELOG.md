# expo-device-hub

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
