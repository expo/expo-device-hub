# LLP 0027: Physical iPhones

**Type:** Explainer
**Status:** Draft
**Systems:** ServeSim, Hub, HubClient, HubComponents, AppleUtils
**Author:** Claude Code (claude-opus-5-5), directed by Thomas Girardier
**Date:** 2026-11-20
**Related:** LLP 0000, LLP 0001, LLP 0003, LLP 0004, LLP 0011, LLP 0014, LLP 0027.000

> File paths such as `Sources/…` and `src/…` are relative to `packages/serve-sim/packages/serve-sim`, unless the text gives a path from the repository root.

## Summary

A paired iPhone or iPad with iOS 27 looks like a simulator to every viewer: the Hub, serve-sim's preview, and other clients of serve-sim. serve-sim lists it, streams its screen with the same video formats, and drives it through the same input socket. Touch, keyboard, Home, screenshots and recording work. The features that need a simulator are refused with a reason and shown as not available.

This document describes what is built. The research behind the native stream is [LLP 0027.000](0027.000-physical-iphone-stream-spike.research.md).

> **Provenance.** Claude Code wrote this document while it built and validated the feature, in three phases: the native screen source, the TypeScript listing, feature gate and session end, and their integration. Thomas Girardier set the direction in the task [confirmed] (Thomas Girardier, 2026-11-19): the names, the hardware UDID as the public id, the features of version 1, the stream requirements, and that a phone's session ends on a disconnect, with no pause or reconnect, as in serve-emu. `[observed]` claims give their source. `[inferred]` claims are guesses that a maintainer must confirm or delete, so this document stays `Draft`.

## Listing

The Hub and serve-sim's grid both list the iPhones and iPads that `xcrun devicectl list devices --json-output <file>` reports, beside the simulators [observed: `packages/@expo/hub-apple-utils/src/list-physical-devices.ts`, `src/physical-devices.ts`].

- A device is listed when it is real hardware (`reality: "physical"`), its platform is iOS or iPadOS, it is paired, and Developer Mode is on. It is listed also when its tunnel is disconnected: opening it connects it.
- Its public id is the hardware UDID, such as `00008101-0016603236F0801E`, in routes, the grid, the CLI and the Hub's device list. Only native code uses the CoreDevice identifier. A hardware UDID is the one thing that makes a device physical: `deviceKindOf` in `src/device-features.ts`.
- It is always booted. Neither the Hub nor serve-sim boots, shuts down or removes it, as for a physical Android device: the Hub's inspector offers no Shut down or Remove for a physical device, and `/grid/api/shutdown` refuses one.
- The Hub marks it `physical: true`. serve-sim's grid rows carry `kind: "physical"` or `kind: "simulator"`, as serve-emu's carry `kind`.
- A device that cannot stream is still listed, unsupported, with a reason. The Mac comes first: `"needs Xcode 27"` when CoreDevice on this Mac is older than 642 (its `CFBundleShortVersionString`), then `"needs iOS 27"` when the device runs an older iOS. The Hub's sidebar warning shows the reason [observed: `UnsupportedDeviceWarning.tsx`].
- serve-sim asks its native add-on for the Mac's part, `physicalDeviceSupport()`, which also checks that the media stream, digitizer and keyboard symbols resolve. Without the add-on, the CoreDevice version decides. The device's own iOS version comes from devicectl, so listing never connects to a phone [observed: `readHostSupport` in `src/physical-devices.ts`].
- serve-sim cannot depend on the private `@expo/hub-apple-utils`, because it is published on its own, so it has its own copy of the devicectl rules. Both copies parse the same fixture and give the same reasons in the same order.

## Starting a session

`/grid/api/start` and the CLI (`serve-sim <hardware udid>`) start a phone as they start a simulator, without the simulator steps [observed: `src/device-lifecycle.ts`, `ensureBooted` and the startup loop in `src/index.ts`]:

- no `simctl boot`, clipboard set-up, network capture, capability loader or default capabilities;
- the CLI refuses `--install-app-path` and `--launch-app-identifier` for a phone with the apps reason;
- the CLI's stale-helper check never recycles a phone's server because simctl does not list it as booted.

`DeviceSession` creates `NativeCapture(udid, settings, undefined, "physical")` and `NativeHid(udid, "physical")` for a hardware UDID. It skips the simulator option read, and it has no reboot handling. If the phone is gone before the first frame, `start()` rejects with "iPhone disconnected" [observed: `src/device-session.ts`, `PhysicalScreenSource.start`].

## Feature gate

A physical device has the live screen, touch, keyboard, Home, screenshots and recording. It has none of the features that need a simulator, through simctl, CoreSimulator, Simulator HID or a dylib injected into the simulator's apps. One table decides this: `DEVICE_FEATURES` and `unavailableDeviceFeatures` in `src/device-features.ts`.

| Feature           | What it covers                                                |
| ----------------- | ------------------------------------------------------------- |
| `clipboard`       | Paste, Copy, and the pasteboard route                         |
| `apps`            | App install, launch, stop, files, URLs, icons, media          |
| `permissions`     | App permissions                                               |
| `location`        | Simulated location                                            |
| `logs`            | Device logs and crash reports                                 |
| `deviceSettings`  | Appearance, accessibility and UI settings, simulator controls |
| `appInjection`    | The injected dylibs: camera injection and network capture     |
| `devtools`        | Web Inspector                                                 |
| `accessibility`   | The accessibility tree                                        |
| `foregroundApp`   | The foreground app                                            |
| `activity`        | Activity metrics                                              |
| `hinge`           | Hinge and fold controls                                       |
| `rotate`          | Rotate                                                        |
| `hardwareButtons` | Every hardware button except Home                             |
| `lifecycle`       | Booting and shutting down                                     |

serve-sim already uses "capability" for an injected dylib (LLP 0007), so the table says "feature".

- **Routes.** The middleware refuses a route of a missing feature with 409 and `{ "error": "<reason>" }` before it routes, for its own routes and the `/helper/<device>/…` routes. Host actions refuse the same way before they run anything; each action names its feature in `HOST_ACTION_FEATURES`, which the compiler keeps complete. The `button` action, the CLI's `serve-sim button` and the preview's bezel buttons refuse any button but Home with the `hardwareButtons` reason.
- **The input socket.** A phone's session drops the messages it cannot take before they reach native code: buttons other than Home, rotate, the hardware and software keyboard settings, CA debug options, memory warnings and Digital Crown. Paste answers with the clipboard reason. Typing a character sends the HID key, never simctl's keyboard setting [observed: `lacks` in `src/device-session.ts`].
- **Home** is the swipe up from the bottom edge, sent natively. The native side also ignores the other buttons on a phone, so the two sides agree.
- **Clients.** The preview config carries `deviceKind` and `unavailableFeatures`, a map from each missing feature to its reason, such as "Location is not available on a physical device.". It leaves out `inputPaste` and `inputCopy` when the clipboard is missing. `@expo/hub-client` reports each missing feature as an absent capability, so the Hub's inspector shows the section as not available (LLP 0000, Steady inspector). It sends no button but Home, and on admission it leaves the hardware keyboard setting alone, so the keyboard toggles stay disabled. serve-sim's preview shows a tool of a missing feature as a card with the reason, and disables Logs and Web Inspector.
- `logs` and `foregroundApp` count as present until the device's config says otherwise. The Hub's steady inspector keeps every other capability that a device reported once; for these two, the device's latest report counts. Without that, a phone's first report, made before its config arrived, kept Current app and Logs in place [observed: `PRESENT_UNTIL_REPORTED` in `useSteadyClient.ts`, found on the device on 2026-11-20].
- A server without `unavailableFeatures` is an older one; a client then keeps every feature.

## Device end

When a phone goes away, by an unplugged cable or a lost connection, its session ends, as serve-emu marks a session whose video stream ended terminal. There is no pause and no reconnect [confirmed] (Thomas Girardier, 2026-11-20) [observed: `markTerminal` in `packages/serve-emu/packages/serve-emu/src/middleware.ts`].

- The native screen source reports the end once through `NativeCapture.subscribeEnd(onEnd)`, with `{"reason":"device-disconnected","message":"iPhone disconnected"}`. A listener that subscribes after the end is called at once. Only a device that serve-sim cannot boot is observed.
- The session closes every viewer's input socket with code 4410 and the reason as its close reason, withdraws the device's state file, and records the reason. For `device-disconnected` the reason is "iPhone disconnected"; for another end, the native `message`.
- Until the device is started again through `/grid/api/start`, `/api?device=<udid>` and the `/api/events` feed answer `{ "device": "<udid>", "ended": { "reason": "<reason>" } }` in place of a config. It has no `url`, so an older client reads it as no device.
- `@expo/hub-client` shows the reason as the device's error and does not start the device again in that connection. Selecting the device again starts it again.

## The native screen source

### The seam

`CaptureEngine` reads frames from a `ScreenSource` (`Sources/SimNative/ScreenSource.swift`), an actor protocol with the members the engine used on `FrameCapture`: start and stop, snapshot size, screenshot pixels, screen size, active screen ID, screen-change observers, canvas sizes and diagnostics. `start` gains an `onEnd` handler, which the simulator source never calls. `SimulatorScreenSource` is the former `FrameCapture`, unchanged. `PhysicalScreenSource` implements the members for a phone [observed].

`CaptureEngine` takes a `ScreenSourceKind` (`simulator` or `physical`). Reboot suspension applies only to simulators. The engine latches the first `ScreenSourceEnd` and passes it to every `subscribeEnd` listener, including one that subscribes after the end [observed: `CaptureEngine.sourceEnded`].

`ScreenSourceKind.inputTarget(deviceUDID:)` gives HID its target: transport, default screen ID, screen size, native panel rotations, whether the device folds, and for a phone a connect step [observed].

### Opening and closing

`PhysicalScreenSource.openDevice` checks host support, looks the phone up, reads its description from CoreDevice's `deviceInfo` JSON, checks the iOS version and picks the display. It then starts a `CoreDeviceMediaStreamSession`: connect, take the usage assertion, start the media stream, adopt the shared socket and receive (LLP 0027.000) [observed: `PhysicalScreenSource.swift`, `CoreDeviceMediaStreamSession.swift`].

`start` returns after the first decoded frame. With no frame within 15 s it fails with "The iPhone sent no screen frames"; if the stream ends first, it fails with "iPhone disconnected" and calls `onEnd`. `stop` sends RTCP BYE, stops the stream by its own id, releases the assertion and closes the socket, in 54–58 ms on the device [observed: 2026-11-20].

### Display choice

`PhysicalScreenPolicy.chooseDisplay` picks the one display that reports active, else the primary display, else the first integrated display. The iPhone 12 lists six displays: the LCD (id 1, primary, integrated, 1170 × 2532) and five wireless displays. None reports `active`, so the primary display wins [observed: `deviceInfo` and `devicectl device info displays`, 2026-11-20].

### Cropping and scaling

The phone encodes 1184 × 2576 for a 1170 × 2532 screen, with the padding on the right and bottom. `PhysicalScreenPolicy.contentSize` fits the display's native size into the encoded size and only scales down, the rule from PR #507 [observed: `scripts/ios-device.patch` on `pr-507`].

`PhysicalFrameCopier` crops in VideoToolbox, which has no source-crop property for pixel transfer. It attaches a clean aperture to the decoded buffer, anchored at the top left, and transfers in `kVTScalingMode_CropSourceToCleanAperture` [observed: `PhysicalFrameCopier.swift`].

- **Video frames** are 4:2:0 video-range copies, sized by `SnapshotSizePolicy` as for simulators.
- **Screenshots** are the last decoded frame, cropped to the full content size, in BGRA.
- **The canvas** for WebRTC is the content size; the recording canvas is the content size rounded up to even.

### Idle floor

The source re-emits the last decoded frame when 200 ms pass without a new one, the simulator's 5 fps floor. The phone sends about 23 fps on a still home screen, so on the device the floor did not fire [observed].

### Orientation

The phone's frames are its panel as it is mounted, like a simulator's. With Calculator turned to landscape (`devicectl device orientation set landscapeLeft`), the stream stayed 1170 × 2532 with the interface drawn sideways, and CoreDevice's `currentOrientation` read `landscape_right` [observed: MJPEG frame and `/config`, 2026-11-20].

So a phone uses the simulator path: the session reports the interface orientation, clients turn the video and map input to panel coordinates with `rawPointForDisplayPoint`, and HID sends those coordinates and edges to CoreDevice unchanged. Screenshots come out upright, as for simulators.

The interface orientation comes from the live `CoreDeviceDisplayInfo.read`, `currentOrientation` of the chosen display, read every second and when the frame shape changes. It follows the interface, not the pose: on the portrait-only home screen, `landscapeLeft` left it at `portrait` [observed].

An earlier draft treated the frames as upright, from PR #507's note that the stream is already rotated [inferred at the time]. The device showed otherwise, and that path is removed. Whether an iPad, or a Wi-Fi stream, sends other frames is not known.

### Device identity

`CoreDeviceBridge.remoteDevice(udid:)` first matches CoreDevice identifiers, then the `udid` value in each device's `deviceInfo`. Simulators match on the first pass, as before. The hardware UDID is read only when the media-stream symbols resolve [observed: `CoreDeviceIdentity.matches`].

### Input

For a physical target, `HIDInjector.setup` connects the phone and opens CoreDevice HID: `UniversalHIDServiceCapability` for touch and `KeyboardHIDCapability` for keys. It never loads the Indigo legacy client. Touches and pinches go to the primary display's digitizer service (`0x100 + 1` on the iPhone 12) in the panel coordinates the client sends. `home` and `swipe_home` send the bottom-edge swipe; other buttons, `buttonHid`, orientation commands, Digital Crown, CA debug, memory warnings and the software-keyboard toggle do nothing on a phone [observed: `HIDInjector.swift`].

### Ending: device disconnected

The media session ends on its own when the socket reports an error (`POLLERR`, `POLLHUP` or a `recv` failure), the phone sends RTCP BYE, CoreDevice invalidates the usage assertion, no packet arrives for 1 s while `deviceInfo` no longer says `connected`, or no packet arrives for 5 s. The phone sends packets continuously, 493 in 3 s on a still home screen, so 5 s of silence means it went away [observed: `CoreDeviceMediaStreamReceiveLoop.silenceCause`].

The source then stops emitting, stops the stream, releases the assertion, clears CoreDevice's cached capabilities for the UDID and calls `onEnd` once with `ScreenSourceEnd.iPhoneDisconnected`.

### Binding surface

- `new NativeCapture(udid, options, screenId?, kind = "simulator")` and `new NativeHid(udid, kind = "simulator")`, with `NativeDeviceKind`.
- `NativeCapture.subscribeEnd(onEnd)`, typed `NativeDeviceEnd` from `src/device-end.ts`. Its unsubscribe stops later calls.
- `physicalDeviceSupport(udid?)`, which returns `{ supported, reason?: "needs-xcode-27" | "needs-ios-27", message?: "needs Xcode 27" | "needs iOS 27", coreDeviceVersion?, osVersion?, deviceFound? }`. On an older CoreDevice it resolves no symbol.

## Tests and validation

Unit tests cover each part without a phone:

- Swift: `PhysicalScreenPolicyTests` (display choice, crop geometry, the Xcode and iOS gates, identifier or UDID matching), `PhysicalScreenSourceTests` and `PhysicalDeviceDescriptionTests` (crop, scale, idle floor, end signal, an end before the first frame, the engine's latched end), and `HEVCFixtureReplayTests`, which replays `Tests/SimNativeTests/Fixtures/iphone12-home-screen.rtp` (3 s, 493 packets) through the receiver and decoder.
- TypeScript: the binding against a fake add-on (`native-physical.test.ts`), the listing and its fixture in both packages, the feature table, routes and host actions (`device-features.test.ts`, `physical-device-gate.test.ts`), a phone's session with fake native classes (`device-session-end.test.ts`: physical capture and HID, the input it drops, the paste refusal, and the end), the Hub's physical rows, hub-client's capabilities, end and keyboard handling, and the steady inspector.

On 2026-11-20 the integrated build ran against an iPhone 12 (iOS 27.2.1, USB, Xcode 27.2, CoreDevice 651.32) [observed]:

- `serve-sim <hardware udid>` streamed it at 1170 × 2532 with the first frame after 0.54–0.78 s. The preview played it over AVCC, MJPEG and WebRTC (173 frames in 3 s). `/api/screenshot` returned a 1170 × 2532 PNG in 70 ms, and a 4 s recording finalized at 1170 × 2532.
- Through the preview's input socket, latency from the gesture to the first changed frame: Notification Center 191–324 ms, closing it 116–156 ms, Home 118–134 ms, Spotlight 131–164 ms, "abc" 83–119 ms.
- In landscape Calculator, a tap on "7" and then "AC" through the preview changed the display to 7 and back to 0.
- The preview showed each missing feature with its reason, and gated routes answered 409.
- The Hub listed the phone, streamed it, showed Current app, Accessibility, Location, Clipboard and Logs as not available, offered no Shut down or Remove, and opened Notification Center from the dashboard.
- T3 Code with this Hub listed the phone as physical, opened it in its Device panel and took a 1170 × 2532 screenshot.

These runs found and fixed: the CLI booting and recycling a phone, the screenshot route refusing a hardware UDID, the frames reported as upright, and the inspector keeping Current app and Logs.

## Manual checklist: unplugging

An unplug cannot be run by an agent. The end flow is covered by the fake-session tests above. Before this ships, a person runs it once with a phone that only they use:

1. Start `node packages/serve-sim/packages/serve-sim/dist/serve-sim.js <hardware udid>` and open the preview. Also open the phone in the Hub.
2. Unplug the cable. Within 5 s, check:
   - the server log shows `session ended: iPhone disconnected`;
   - the preview's input socket closed with code 4410;
   - `curl 'http://127.0.0.1:<port>/api?device=<udid>'` answers `{"device":"<udid>","ended":{"reason":"iPhone disconnected"}}`;
   - the Hub shows "iPhone disconnected" as the device's error and does not start it again by itself.
3. Plug the phone in again and select it in the Hub, or call `/grid/api/start`. It streams again.
4. Unplug the phone before a stream starts, then start it. Starting fails with "iPhone disconnected".
5. Repeat step 2 with a phone connected over Wi-Fi, by turning off the phone's Wi-Fi.

## Open questions

- Xcode 26: whether its CoreDevice has the symbols. This Mac has only Xcode 27.2. If one is missing, the phone is listed as "needs Xcode 27" and nothing else is called.
- A real unplug and a Wi-Fi connection have not been tried (see the checklist).
- A second stream to the same phone at the same time has not been tried; stream id 0 was used in every run.
- iPads have not been tried, including their display choice and frame orientation.
- agent-device in T3 Code needs an XCTest runner on the phone. It was not run, so whether it can drive a physical iPhone is not known.
