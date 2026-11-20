# LLP 0026: Physical iPhone screen source

**Type:** Explainer
**Status:** Draft
**Systems:** ServeSim
**Author:** Claude Code (Claude Opus 5.5)
**Date:** 2026-11-20
**Related:** LLP 0020, LLP 0001, LLP 0004, LLP 0014

> File paths such as `Sources/…` are relative to `packages/serve-sim/packages/serve-sim`, unless the text gives a path from the repository root.

## Summary

serve-sim's native add-on can stream and drive a physical iPhone over USB. The research behind it is [LLP 0020](0020-serve-sim-physical-iphone-stream-spike.research.md). This document describes what is built in the add-on and the JavaScript binding in `src/native.ts`. Listing phones, session start and stop, routes and the hub are not part of it.

A capture engine now reads frames from a `ScreenSource`. `SimulatorScreenSource` is the former `FrameCapture`, unchanged. `PhysicalScreenSource` implements the same members for a phone. `HIDInjector` gets its input target from the source kind, and a physical target always uses CoreDevice HID [observed: `Sources/SimNative/ScreenSource.swift`, `CaptureEngine.swift`, `HIDInjector.swift`].

## The screen source seam

`ScreenSource` (`Sources/SimNative/ScreenSource.swift`) is an actor protocol. It holds the members `CaptureEngine` used on `FrameCapture`:

- `start(deviceUDID:screenID:onFrame:onEnd:)` and `stop(preservingObservers:)`. `onFrame` receives the pixel buffer, host-clock timestamp, canvas and `CapturedScreenInfo`, as before. `onEnd` is new. The simulator source never calls it.
- `setSnapshotMaxDimension`, `screenshotPixels(screenID:)`, `getScreenSize`, `activeScreenID`, `subscribeScreenChanges`, `webRTCEncodeCanvasSize`, `recordingCanvasSize`.
- `isFoldable`, `supportsDevicePose`, and the diagnostics counters behind `webRTCSenderStats`.
- `framesUpright()`, which is false for a simulator and true for a phone.

`CaptureEngine` takes a `ScreenSourceKind` (`simulator` or `physical`) and makes the matching source. Reboot suspension applies only to simulators. The engine latches the first `ScreenSourceEnd` and passes it to every `subscribeEnd` listener, including one that subscribes after the end [observed: `CaptureEngine.sourceEnded`, `subscribeEnd`].

`ScreenSourceKind.inputTarget(deviceUDID:)` gives HID its target as a `ScreenInputTarget`. The fields are transport, default screen ID, screen size, native panel rotations, whether the device folds, and for a phone a connect step and an interface-orientation reader. The simulator target is read by `SimulatorScreenSource.inputTarget`. This code moved from `HIDInjector.setup` without changes [observed].

## PhysicalScreenSource

### Opening and closing

`PhysicalScreenSource.openDevice` checks host support (see [Availability](#availability)), then looks the phone up. It reads the phone's description from CoreDevice's `deviceInfo` JSON, checks the iOS version and picks the display. Then it creates a `CoreDeviceMediaStreamSession`. Starting the session runs the LLP 0020 sequence: connect, take the usage assertion with the five device states, start the media stream, adopt the shared socket, and receive [observed: `Sources/SimNative/PhysicalScreenSource.swift`, `CoreDeviceMediaStreamSession.swift`].

`start` returns only after the first decoded frame. If no frame arrives within 15 s, it fails with "The iPhone sent no screen frames". If the stream ends first, it fails with "iPhone disconnected" and also calls `onEnd`. `stop` sends RTCP BYE, stops the stream by its own id, releases the assertion and closes the socket. In the device runs below, this took 54–58 ms [observed: validation log, 2026-11-20].

The test seam is `PhysicalScreenSource(open:)`. It returns a `PhysicalDeviceConnection`: a description, a `PhysicalStreamSession` and an orientation reader. The unit tests use a fake session [observed: `Tests/SimNativeTests/PhysicalScreenSourceTests.swift`].

### Display choice

`PhysicalScreenPolicy.chooseDisplay` (`Sources/StreamingPolicy/PhysicalScreenPolicy.swift`) picks, in order: the one display that reports active, the primary display, then the first integrated display. The iPhone 12 lists six displays: the LCD (id 1, primary, integrated, native size 1170 × 2532) and five wireless displays. None of the six has an `active` value, so the primary display wins. HID uses service `0x100 + 1` [observed: `deviceInfo` dump and `devicectl device info displays`, 2026-11-20].

### Cropping and scaling

The phone encodes 1184 × 2576 for a 1170 × 2532 screen. The padding is on the right and bottom. `PhysicalScreenPolicy.contentSize` fits the display's native size into the encoded size. It swaps the two sides when the frame is landscape and only ever scales down. This is the rule from PR #507 [observed: `scripts/ios-device.patch` on `pr-507`].

`PhysicalFrameCopier` crops in VideoToolbox. VideoToolbox has no source-crop property for pixel transfer. So the copier attaches a clean aperture to the decoded buffer: content size, with offsets that anchor it at the top left. The transfer then runs in `kVTScalingMode_CropSourceToCleanAperture` [observed: `Sources/SimNative/PhysicalFrameCopier.swift`; the SDK header lists no source-crop key].

- **Video frames** are 4:2:0 video-range copies. They are sized by `SnapshotSizePolicy` from the content size and the requested snapshot size, as for simulators.
- **Screenshots** are the last decoded frame, cropped to full content size, in BGRA.
- **The canvas** for WebRTC is the content size. The recording canvas is the content size rounded up to even.

A unit test fills the padding red and the content green. It checks that all four corners of the screenshot are green [observed: `testCropsEncoderPaddingFromVideoFramesAndScreenshots`].

### Idle floor

The source re-emits the last decoded frame when 200 ms pass without a new one. This is the simulator's 5 fps floor. The phone kept sending about 23 fps on a still home screen, so on the device the floor did not fire. The unit test covers it [observed: 0 idle re-emissions in both device runs; `testReemitsTheLastFrameOnTheIdleFloor`].

### Screen information and orientation

`CapturedScreenInfo` carries the content size and `SimDisplayMetadata`: display id, interface orientation name and the display's `chromeIdentifier` (`com.apple.dt.devicekit.chrome.phone4` on the iPhone 12). `fold` and `pose` are absent.

The interface orientation comes from the live `CoreDeviceDisplayInfo.read` call, `currentOrientation` of the chosen display, which took about 9 ms. It is read every second, and right away when the frame changes between portrait and landscape. Readings go to `PhysicalOrientationObservation` so HID can reuse them.

`currentOrientation` follows the interface, not the physical pose. With the phone set to `landscapeLeft` on the portrait-only home screen, CoreDevice reported device orientation `landscapeLeft` and display rotation `rot0` [observed: `devicectl`, 2026-11-20].

The phone's frames already show its interface orientation, so `framesUpright()` is true. The binding reports `framesUpright: true` from `screenSize()`, as serve-emu does [inferred: from PR #507's note that the stream is already rotated; the iPhone 12 home screen could not be rotated to confirm].

## Device identity

The public id of a phone is its hardware UDID, for example `00008101-0016603236F0801E`. `CoreDeviceBridge.remoteDevice(udid:)` first matches CoreDevice identifiers. Only if none matches does it compare the `udid` value in each device's `deviceInfo`. Simulators match on the first pass, as before [observed: `CoreDeviceBridge.first(matching:in:identifier:hardwareUDID:)`, `CoreDeviceIdentity.matches`].

The hardware UDID is read only when the media-stream symbols resolve. On an older CoreDevice, a phone cannot be found by UDID, and physical streaming is unavailable there anyway.

## Input

For a `physical` target, `HIDInjector.setup` runs these steps:

1. Connects the phone.
2. Opens CoreDevice HID: `UniversalHIDServiceCapability` for touch and `KeyboardHIDCapability` for keys. Opening the keyboard service also starts delivery.
3. Starts reading the interface orientation every 500 ms.

It never loads the Indigo legacy client [observed: `HIDInjector.setup(deviceUDID:target:)`].

Touches are normalized coordinates in the frame as shown. `PhysicalScreenPolicy.digitizerPoint` maps them to the portrait digitizer with the same table as hub-client's `rawPointForDisplayPoint` and PR #507:

- `landscape_left`: `(y, 1 − x)`
- `landscape_right`: `(1 − y, x)`
- `portrait_upside_down`: `(1 − x, 1 − y)`

`digitizerEdge` moves the system-edge flag to the digitizer edge that the mapped points land on. The orientation is fixed at touch-down and kept until lift, for single touches and pinches separately [observed: `HIDInjector.physicalOrientation(for:multiTouch:)`].

`home` and `swipe_home` both send the existing bottom-edge swipe. Other buttons, `buttonHid`, orientation commands, Digital Crown, CA debug, memory warnings and the software-keyboard toggle do nothing on a phone. Keys go through the CoreDevice keyboard.

The `rot90` → `landscape_left` name comes from `SimulatorScreenOrientation.name(forRotation:)`. Whether the phone's `rot90` is the interface that the `landscape_left` mapping expects was not confirmed on a device [inferred].

## Ending: device disconnected

The media session ends on its own when one of these happens:

- the socket reports an error (`POLLERR`, `POLLHUP` or a `recv` failure);
- the phone sends RTCP BYE;
- CoreDevice invalidates the usage assertion;
- no packet arrives for 1 s and the phone's `deviceInfo` `state` is no longer `connected`;
- no packet arrives for 5 s.

The 5 s limit is safe because the phone sends packets continuously: 493 in 3 s on a still home screen [observed: `CoreDeviceMediaStreamReceiveLoop.silenceCause`; fixture recording].

The source then stops emitting frames. It stops the stream, releases the assertion, clears CoreDevice's cached capabilities for that UDID, and calls `onEnd` once with `ScreenSourceEnd.iPhoneDisconnected`. The source does not pause or reconnect, which matches serve-emu.

JavaScript sees the end through `NativeCapture.subscribeEnd(onEnd)`. The callback runs once with:

```json
{ "reason": "device-disconnected", "message": "iPhone disconnected" }
```

A listener that subscribes after the end is called right away. The capture still needs `stop()`.

## Availability

`PhysicalDeviceHost.support()` reports `needs-xcode-27` in either of these cases:

- CoreDevice's `CFBundleShortVersionString` is below 642 or cannot be read;
- any media-stream, digitizer or keyboard symbol is missing.

When the version is too old, no symbol is resolved. With a phone, `PhysicalDeviceSupport.device` reports `needs-ios-27` when `osVersionNumber` is below 27.

JavaScript calls `physicalDeviceSupport(udid?)`, which returns:

```ts
{ supported: boolean; reason?: "needs-xcode-27" | "needs-ios-27"; message?: "needs Xcode 27" | "needs iOS 27";
  coreDeviceVersion?: string; osVersion?: string; deviceFound?: boolean }
```

`deviceFound` is false when the id matches no CoreDevice device. `PhysicalScreenSource.start` and HID setup throw the same messages, for example "Physical iPhone streaming needs iOS 27" [observed: `PhysicalDeviceDescription.swift`; `support` output on this Mac: `{"coreDeviceVersion":"651.32","deviceFound":true,"osVersion":"27.2.1","supported":true}`].

## Binding surface

These are the only JavaScript changes [observed: `src/native.ts`, `Sources/SimNative/sim-module.swift`]:

- `new NativeCapture(udid, options, screenId?, kind = "simulator")` and `new NativeHid(udid, kind = "simulator")`. The kind is `NativeDeviceKind`.
- `NativeCapture.subscribeEnd(onEnd)`, typed `NativeCaptureEnd`.
- `NativeScreenInfo.framesUpright`.
- `physicalDeviceSupport(udid?)`, typed `PhysicalDeviceSupport`.

## Tests and validation

- **StreamingPolicyTests** (`PhysicalScreenPolicyTests`): display choice, crop and scale geometry in portrait and landscape, touch and edge mapping in all four orientations, the Xcode and iOS gates, and identifier or UDID matching.
- **SimNativeTests** (`PhysicalScreenSourceTests`, `PhysicalDeviceDescriptionTests`): crop, scale, landscape, idle floor, end signal, stop, wrong screen, an end before the first frame, the engine's latched end, `deviceInfo` parsing, the support report shape and lookup order.
- **`HEVCFixtureReplayTests`**: replays `Tests/SimNativeTests/Fixtures/iphone12-home-screen.rtp`, 3 s and 493 packets of the iPhone 12 home screen. The format is `SSRTP1`, then a 32-bit millisecond offset, a 16-bit length and the datagram, repeated. The test feeds it through `HEVCRTPReceiver` and `HEVCDecoder` and expects 79 frames at 1184 × 2576 with no loss.
- **`src/__tests__/native-physical.test.ts`**: the JavaScript binding against a fake add-on.

`Sources/PhysicalDeviceStreamSpike` now builds against every non-Node, non-WebRTC source in `SimNative`. Its subcommands are `validate <udid> <dir> [--rotate]`, `record-rtp`, `support` and `stream` (the LLP 0020 measurement).

On 2026-11-20, two `validate` runs drove the real `PhysicalScreenSource` and `HIDInjector` against the iPhone 12 (iOS 27.2.1, USB, Xcode 27.2) [observed]:

- `start` returned with its first frame after 0.51 s.
- The frames were 1170 × 2532.
- 477–519 frames arrived in about 12 s. The frame rate rose above 40 fps while the screen animated.
- The latency from the start of a gesture to the first changed frame was 180–430 ms for Notification Center, 93–128 ms for the Home swipe, 114–124 ms for Spotlight and 92–859 ms for typing. The 859 ms was the first keypress of the first run.

| Step                          | Pixels changed | Compared with |
| ----------------------------- | -------------- | ------------- |
| Notification Center open      | 99.1 %         | home          |
| Notification Center closed    | 2.3–2.6 %      | home          |
| Home swipe on the home screen | 0.1 %          | home          |
| Spotlight open                | 98.8–98.9 %    | home          |
| "abc" typed                   | 6.8–19.5 %     | Spotlight     |
| Spotlight dismissed           | 0.4–0.9 %      | home          |

The saved frames show Notification Center, then Spotlight with "abc" in the search field, then the home screen again. None has a padding strip.

The built add-on, driven from `src/native.ts` under Bun 1.3.14, did the following:

- reported support;
- streamed the phone at 1170 × 2532 with `framesUpright: true`;
- opened and closed Notification Center through `NativeHid(udid, "physical")`;
- stopped without an end event.

The simulator path was checked on an iPhone 17 simulator created for the run and then deleted. It captured 1206 × 2622 frames, and one tap on the Search pill opened Spotlight.

`devicectl device orientation set landscapeLeft` succeeded, but the iPhone 12 home screen is portrait-only. The interface, the stream and CoreDevice's `currentOrientation` stayed portrait, so the landscape mapping was not exercised on the device. The phone was set back to portrait.

## Open questions

- The landscape touch mapping and the `rot90` naming need a device with a landscape interface: an app that rotates, or an iPad. Until then they are [inferred], so this document stays Draft.
- Unplugging the phone was not tried. The disconnect path is covered by the fake session and by the socket and assertion handlers.
- A second stream to the same phone has not been tried. Stream id 0 was used in every run (LLP 0020).
