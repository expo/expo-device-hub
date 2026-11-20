# LLP 0027: Physical iPhones

**Type:** Explainer
**Status:** Draft
**Systems:** ServeSim, Hub, HubClient, HubComponents, AppleUtils
**Author:** Claude Code (claude-opus-5-5), directed by Thomas Girardier
**Date:** 2026-11-20
**Revised:** 2026-11-20 (final validation: selecting an ended phone again, one stream per phone, concurrent viewers, agent-device and T3's Device panel); 2026-11-20 (validation follow-up: a real CoreDevice disconnect, Xcode 26 compilers and an older CoreDevice)
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
- The version check reads CoreDevice's version first and resolves no media-stream symbol when it is older than 642 [observed: `PhysicalDeviceHost.support`].
- `SERVE_SIM_COREDEVICE_INFO_PLIST` names another `Info.plist` for that version, such as one that reports `600.1`, so a Mac with Xcode 27 can act as one with an older CoreDevice. Only the version check reads it: the native `PhysicalDeviceHost.coreDeviceInfoPlist`, serve-sim's fallback in `coreDeviceInfoPlist` (`src/physical-devices.ts`), and the Hub's `coreDeviceInfoPlist` in `@expo/hub-apple-utils`. The Hub runs serve-sim in its own process, so one variable sets both.
- serve-sim cannot depend on the private `@expo/hub-apple-utils`, because it is published on its own, so it has its own copy of the devicectl rules. Both copies parse the same fixture and give the same reasons in the same order.

## Starting a session

`/grid/api/start` and the CLI (`serve-sim <hardware udid>`) start a phone as they start a simulator, without the simulator steps [observed: `src/device-lifecycle.ts`, `ensureBooted` and the startup loop in `src/index.ts`]:

- no `simctl boot`, clipboard set-up, network capture, capability loader or default capabilities;
- the CLI refuses `--install-app-path` and `--launch-app-identifier` for a phone with the apps reason;
- the CLI's stale-helper check never recycles a phone's server because simctl does not list it as booted.

A phone that the listing marks unsupported is refused before anything starts: `/grid/api/start` and the screenshot route answer 409 with the listing's reason, such as `{ "ok": false, "error": "needs Xcode 27" }`, and the CLI exits with `<udid> cannot stream: needs Xcode 27` [observed: `physicalStartRefusal` in `src/physical-devices.ts`]. `@expo/hub-client` shows a 409 from the start request as the device's error and does not ask again; any other start failure keeps the earlier behavior, waiting for the helper. serve-sim's preview shows the reason under the phone in its placeholder, which names a phone's runtime without "Simulator".

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
- **Clients.** The preview config carries `deviceKind` and `unavailableFeatures`, a map from each missing feature to its reason, such as "Location is not available on a physical device.". It leaves out `inputPaste` and `inputCopy` when the clipboard is missing. `@expo/hub-client` reports each missing feature as an absent capability, and in `unavailableReasons` gives serve-sim's reason for the capability (`rotate` is `orientation`, `hinge` is `fold`). The Hub's inspector shows a section of a missing capability as not available, and inside Device options, which keeps its rows, locks each row of a missing capability with the reason: every settings row and the keyboard toggles with the `deviceSettings` reason, Orientation with the `rotate` reason. The toolbar's Rotate locks with the `rotate` reason too (LLP 0000, Steady inspector). hub-client sends no button but Home, and on admission it leaves the hardware keyboard setting alone, so the keyboard toggles stay disabled. serve-sim's preview shows a tool of a missing feature as a card with the reason, and disables Logs and Web Inspector.
- `logs` and `foregroundApp` count as present until the device's config says otherwise. The Hub's steady inspector keeps every other capability that a device reported once; for these two, and for each capability with a reason in `unavailableReasons`, the device's latest report counts. Without that, a phone's first report, made before its config arrived, kept Current app and Logs in place, and kept Orientation and the settings rows unlocked [observed: `latestReportCounts` in `useSteadyClient.ts`, both found on the device on 2026-11-20].
- A server without `unavailableFeatures` is an older one; a client then keeps every feature.

## Device end

When a phone goes away, by an unplugged cable or a lost connection, its session ends, as serve-emu marks a session whose video stream ended terminal. There is no pause and no reconnect [confirmed] (Thomas Girardier, 2026-11-20) [observed: `markTerminal` in `packages/serve-emu/packages/serve-emu/src/middleware.ts`].

- The native screen source reports the end once through `NativeCapture.subscribeEnd(onEnd)`, with `{"reason":"device-disconnected","message":"iPhone disconnected"}`. A listener that subscribes after the end is called at once. Only a device that serve-sim cannot boot is observed.
- The session closes every viewer's input socket with code 4410 and the reason as its close reason, withdraws the device's state file, and records the reason. For `device-disconnected` the reason is "iPhone disconnected"; for another end, the native `message`.
- Until the device is started again through `/grid/api/start`, `/api?device=<udid>` and the `/api/events` feed answer `{ "device": "<udid>", "ended": { "reason": "<reason>" } }` in place of a config. It has no `url`, so an older client reads it as no device.
- The end is this server's. It wins over a state file that another server published for the same phone, because this server's helper routes would refuse the phone anyway. The feed sends the end, and a start that clears it, as soon as it is recorded, without waiting for a change in the state directory [observed: `deviceEndConfig` and `subscribeDeviceEnds` in `src/device-end.ts`]. Without this, a Hub whose phone ended while T3 Code's Hub still had a state file for it showed "Live" over the last frame, and its viewer's input socket closed with 4410 every 1.5 s [observed: Hub run on 2026-11-20].
- Its video responses (`stream.mjpeg`, `stream.avcc`) end with the session.
- Until then nothing opens a session for it on its own. A request to its helper routes, such as a viewer's reconnecting input socket or video stream, gets no session: `getDeviceSession` throws `DeviceEndedError`, an input socket closes with 4410 and the reason, and the screenshot route answers 409 with the reason. Only `/grid/api/start` and the CLI's start (`startDeviceSession`) clear the end. Without this, the Hub's viewer reconnected 1.5 s after the end, which started the phone again and replaced the `ended` report [observed: Hub run on 2026-11-20].
- `@expo/hub-client` shows the reason as the device's error and does not start the device again on its own. A start is always the viewer's: selecting another device and then the phone starts a new connection, and so does clicking the phone's row while it is selected. The Hub counts every click on a device row, the selected one included, in `deviceSelections`, and passes the count to the client as `startRequest`. When it changes while the device's session has ended, or its start was refused, the client asks `/grid/api/start` once more; while the session is connecting or live it changes nothing [observed: `startEndedDevice` in `useIosDevice.ts`, `selectDevice` in `dashboardStore.ts`]. This is how the Hub treats a choice that failed, as a new choice of 3D retries a model that did not load (LLP 0015). The Android client keeps reconnecting its socket on its own and ignores `startRequest` [observed: `useAndroidDevice.ts`]. serve-sim's preview shows the reason under the phone in its placeholder, with Start.

## One stream per phone

A phone sends one CoreDevice media stream at a time. A second stream, from another process, takes the phone over: the first server's socket fails about 0.3 s later [observed: two `serve-sim <udid>` servers with separate state directories, 2026-11-20].

- **Viewers.** Every viewer of a server, such as two preview pages or the Hub's dashboard and a preview, shares that server's one session and its one media stream. Each gets the frames, input from each reaches the phone, a viewer that leaves does not stop the others, and the end closes every viewer's input socket with 4410.
- **Servers.** A server claims a phone's stream before its native capture starts, with a lock file in serve-sim's state directory, `physical-stream-<UDID>.lock`, that holds its pid. It releases the claim when the session closes or ends. A claim whose process has exited is taken over [observed: `claimPhysicalStream` in `src/physical-stream-lock.ts`, `DeviceSession.start` and `close`].
- A second server is refused with the holder's pid, before anything starts: `/grid/api/start` and the screenshot route answer 409 `{ "ok": false, "error": "iPhone is streaming in another serve-sim (pid 31643)" }`, the CLI exits with `<udid> cannot stream: iPhone is streaming in another serve-sim (pid 31643)`, and a session that a viewer opens rejects with the same reason [observed: `physicalDeviceStartRefusal`].
- A server that serves other servers' devices through its own helper routes (`proxyHelpers`, as the Hub does) offers no config for a phone that another server streams, so its client asks for a start and shows the 409 reason. Without this, the Hub stayed on "Loading" while the CLI streamed the phone [observed: `servedHere` in `src/middleware.ts`, Hub run on 2026-11-20].
- The lock covers serve-sim processes that share a state directory: the CLI, the Hub and T3 Code's Hub use `$TMPDIR/serve-sim` by default. A server with another `SERVE_SIM_STATE_DIR`, or another app that streams the phone's screen, still takes the phone over, and the first server then ends with "iPhone disconnected" although the phone is still connected.

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

- Swift: `PhysicalScreenPolicyTests` (display choice, crop geometry, the Xcode and iOS gates, identifier or UDID matching), `PhysicalScreenSourceTests` and `PhysicalDeviceDescriptionTests` (crop, scale, idle floor, end signal, an end before the first frame, the engine's latched end), `PhysicalDeviceHostTests` (the `SERVE_SIM_COREDEVICE_INFO_PLIST` override and an older or missing CoreDevice), and `HEVCFixtureReplayTests`, which replays `Tests/SimNativeTests/Fixtures/iphone12-home-screen.rtp` (3 s, 493 packets) through the receiver and decoder.
- TypeScript: the stream claim (`physical-stream-lock.test.ts`), the binding against a fake add-on (`native-physical.test.ts`), the listing and its fixture in both packages, the feature table, routes and host actions (`device-features.test.ts`, `physical-device-gate.test.ts`), a phone's session with fake native classes (`device-session-end.test.ts`: physical capture and HID, the input it drops, the paste refusal, the end, video responses ending with it, no session for an ended phone until it is started, a phone that another server streams refused before its capture starts, and the claim released on close), an ended phone's input socket and screenshot (`helper-hid-websocket.test.ts`, `physical-device-gate.test.ts`), discovery and its feed reporting this server's end over another server's state file, the 409 start refusal and no proxied config for a phone that another server streams (`physical-device-gate.test.ts`), the start refusal and the plist override in both packages, the preview's end reason and placeholder (`stream-config.test.ts`, `device-placeholder.test.tsx`), the Hub's physical rows, hub-client's capabilities, end, start refusal, keyboard handling and a start on selecting an ended or refused phone again (`ios-physical-device.test.tsx`), the Hub's count of row clicks (`dashboardStore.test.ts`), and the steady inspector.

On 2026-11-20 the integrated build ran against an iPhone 12 (iOS 27.2.1, USB, Xcode 27.2, CoreDevice 651.32) [observed]:

- `serve-sim <hardware udid>` streamed it at 1170 × 2532 with the first frame after 0.54–0.78 s. The preview played it over AVCC, MJPEG and WebRTC (173 frames in 3 s). `/api/screenshot` returned a 1170 × 2532 PNG in 70 ms, and a 4 s recording finalized at 1170 × 2532.
- Through the preview's input socket, latency from the gesture to the first changed frame: Notification Center 191–324 ms, closing it 116–156 ms, Home 118–134 ms, Spotlight 131–164 ms, "abc" 83–119 ms.
- In landscape Calculator, a tap on "7" and then "AC" through the preview changed the display to 7 and back to 0.
- The preview showed each missing feature with its reason, and gated routes answered 409.
- The Hub listed the phone, streamed it, showed Current app, Accessibility, Location, Clipboard and Logs as not available, offered no Shut down or Remove, and opened Notification Center from the dashboard. Its Device options rows first showed locked without a reason, and Orientation stayed open because the phone reported it before its config arrived. After the fix, the settings rows and keyboard toggles lock with "Simulator settings are not available on a physical device.", Orientation and Rotate with "Rotate is not available on a physical device.", Show device shape stays usable, and a simulator's Device options are unchanged.
- T3 Code with this Hub listed the phone as physical, opened it in its Device panel and took a 1170 × 2532 screenshot.

These runs found and fixed: the CLI booting and recycling a phone, the screenshot route refusing a hardware UDID, the frames reported as upright, the inspector keeping Current app and Logs, and the inspector keeping Orientation and the settings rows unlocked.

### Validation on 2026-11-20: a real disconnect

An agent cannot pull the cable, so CoreDevice dropped the connection instead: `RemoteDevice.disconnect(targetQueue:completionHandler:)`, the API behind the phone's "Disconnect Device" feature (`com.apple.coredevice.feature.disconnectdevice`), called from a harness built like the spike, with `CoreDeviceBridge.remoteDevice(udid:)` and a forwarder whose target is resolved at run time. It tears down the phone's CoreDevice tunnel and leaves it paired: devicectl went from `connected` to `available (paired)` for that phone only, the other two phones stayed connected, and the streaming session's usage assertion was invalidated with `CoreDeviceError` 4006, "The tunnel was forcefully disconnected by a client". The tunnel stayed down for at least 60 s until a client asked for it; opening the phone in serve-sim reconnected it, with the first frame after 1.4 s. The real end path ran, not a fake: the receive loop's assertion check, `PhysicalScreenSource`, the end subscription and `endDeviceSession` [observed].

- **serve-sim alone** (CLI and its preview in headless Chrome): the server logged `media stream ended` and `session ended: iPhone disconnected` once, 106–114 ms after the disconnect call; the preview's input socket closed with 4410 "iPhone disconnected" about 100 ms after; `/api` and `/api/events` answered `ended`; the preview showed "iPhone · iOS 27.2.1 · iPhone disconnected · Start"; the server idled at 0 % CPU and exited 6 ms after SIGINT. `/grid/api/start` after `devicectl device info details` streamed again, 62 frames in 3 s.
- **The Hub** (`--platform ios`): end 114–120 ms after the disconnect; the dashboard showed "iPhone · Error" and "iPhone disconnected" over the last frame; in 30 s it sent no start and the phone did not stream; `/api` stayed `ended`. Selecting the simulator and then the phone streamed again, 61 frames in 3 s.
- **T3 Code** with this Hub: its Hub reported `ended` 125 ms after the disconnect and ended the viewer's video response at 123 ms. Then `device_screenshot` failed with "The device hub could not complete the request" (the Hub answered 409 "iPhone disconnected"), and `device_list` still listed the phone as booted, physical and open. After `device_close`, `device_open` streamed it again. T3 starts a capture only while something views the phone: with no viewer, a disconnect ends nothing, and the next screenshot reconnects the phone.

These runs found and fixed: viewers' reconnecting sockets and streams started an ended phone again, video responses stayed open after the end, and the preview fell back to its "Simulator" placeholder without the reason.

### Validation on 2026-11-20: Xcode 26

Xcode 26 is not installed on this Mac. Expo publishes serve-sim from Xcode 26.6 ([LLP 0014](0014-serve-sim-xcode-support-and-ci.decision.md)), which ships Swift 6.3.3; Xcode 26.0 to 26.3 ship Swift 6.2.x, and this Mac's Xcode 27.2 ships Swift 6.4.2 (swift.org's release list). The swift.org toolchains for Swift 6.2.4 and 6.3.3 were installed without sudo into `~/Library/Developer/Toolchains`; each package is signed by "Developer ID Installer: Swift Open Source (V9AUD2URP3)" and notarized. Builds used the macOS 26.5 SDK from the Command Line Tools, with SwiftPM's native build system: Swift Build applied Xcode 27's compiler flags [observed].

- **Swift 6.2.4**: the add-on and the spike build. `swift test` cannot: Xcode 27.2's XCTest was built with Swift 6.4.2. The 6.2.4 add-on, swapped into serve-sim, streamed the phone and ended on the disconnect as above.
- **Swift 6.3.3**: the add-on, the spike and `swift test` (330 XCTest and 106 Swift Testing tests) pass.
- They found one problem: `static NSNumber *const SSHEVCPayload = @100;` in `CoreDeviceMediaNegotiator.m` is a constant only for Xcode 27's clang; the swift.org clangs of 6.2.4 and 6.3.3 reject it. The payload is now an integer, boxed where it is used.
- **Deployment targets**: with `-Werror=unguarded-availability` and `-Werror=unguarded-availability-new`, the add-on builds for `arm64-apple-macosx14.0` (Package.swift) and `arm64-apple-macosx26.0`, and the spike for macOS 14 and 26. Building against the macOS 26.5 SDK also shows that the code uses nothing newer.
- **Load**: `nm -u` lists no CoreDevice, CoreDeviceProtocols or AVConference symbol in the add-on built by 6.2.4, 6.3.3 or 6.4.2, and no private framework is a load command.
- **An older CoreDevice**, with `SERVE_SIM_COREDEVICE_INFO_PLIST` reporting `600.1`: serve-sim's grid, its preview and the Hub listed all three phones unsupported with "needs Xcode 27" (the Hub's sidebar: "Cannot stream iPhone: needs Xcode 27"); `/grid/api/start` and the screenshot route answered 409, the CLI exited with the reason, and the Hub showed "Device screen unavailable — needs Xcode 27". Under lldb, `SSCoreDeviceMediaStreamAvailable` and `SSCoreDeviceMediaStreamTypeMetadata` were never called, against 258–260 calls in the same runs without the override. A simulator streamed in both serve-sim and the Hub. Without the override, the phones were supported and streamed.

### Validation on 2026-11-20: reselecting, viewers, servers, agent-device and T3's panel

Same Mac and iPhone 12; the disconnect is `RemoteDevice.disconnect` as above [observed].

- **Selecting the ended phone again.** The Hub streamed the phone (63 frames in 3 s), ended 124 ms after the disconnect with one 4410 close and "iPhone · Error · iPhone disconnected", sent no start in 30 s, and after a click on the phone's selected row streamed again in 1.5 s (61 frames in 3 s). The first run found the stale `/api` answer described under [Device end](#device-end).
- **Two viewers on one server.** Two preview pages of `serve-sim <udid>` decoded 60 and 60 frames in 3 s. A Notification Center swipe down from the first opened it, a swipe up from the second closed it, and the second kept 60 frames in 3 s after the first closed. Two viewers then both closed with 4410 "iPhone disconnected" 104 ms after the disconnect. In the Hub, its dashboard received about 60 MJPEG frames in 3 s (21.8 MB) and the Hub-served preview decoded 60, alongside it; the end reached the Hub 135 ms after the disconnect and `/api` answered `ended`.
- **The Hub-served preview has no input.** The Hub accepts the input socket only at `/helper/ws?device=<udid>`, the path that `@expo/hub-client` uses. serve-sim's preview, served by the Hub under `/vendor/serve-sim/`, opens `/helper/<udid>/ws`, which the Hub closes (1006), so its swipe did nothing. This is not specific to phones: the Hub registers exact upgrade paths for every device [observed: `packages/expo-device-hub/src/server/index.ts`].
- **Two servers.** With separate state directories, the second server's stream took the phone over and the first ended with "iPhone disconnected" 340 ms after the second started streaming. With the stream claim and a shared state directory, the second CLI exited in 140 ms with the holder's pid while the first kept 61–63 frames in 3 s. A Hub opened on the phone while the CLI streamed it showed "iPhone is streaming in another serve-sim (pid 31643)" as the device's error, and the CLI kept streaming (305 frames in 15 s).
- **agent-device in T3 Code.** `device_open` returned the launcher. `open` without an app and `screenshot` worked (1170 × 2532 in about 1 s). `snapshot` needs an app session; `open com.apple.springboard` gave one, then `snapshot -i` failed: the runner project's team, `2S799L9W4M`, has no account on this Mac, and no profile matches `com.callstack.agentdevice.runner`. T3's agent-device daemon has no `AGENT_DEVICE_IOS_TEAM_ID` and does not take it from the launcher's environment. Standalone, with a team already configured here (`AGENT_DEVICE_IOS_TEAM_ID=VQG2PWG6S5`, `AGENT_DEVICE_IOS_BUNDLE_ID=ai.newquest.agentdevice.runner`, whose profiles include this phone), the runner built, signed and installed, and iOS refused to launch it: "The Developer App Certificate is not trusted". A person must trust the developer app on the phone (Settings → General → VPN & Device Management) and make T3's agent-device daemon start with those two variables. Whether agent-device then drives a physical iPhone is not known.
- **T3 Code's Device panel.** A pairing link from `t3 pair` opened T3's web UI in headless Chrome. The Device panel listed the three phones under "iOS Simulators", streamed the phone from the Hub through T3's proxy, and a Notification Center swipe down and up from the panel opened and closed it. With a pairing limited to `orchestration:read`, `orchestration:operate` and `preview:operate`, T3's proxy admitted the panel's input socket and sent the touches, but the phone did not move; with the default scopes it did.

### Reinstalling this build in T3 Code

T3 Code runs its own Hub from `~/.t3/tools/expo-device-hub/0.22.1`, and the stock version does not list phones. To run this branch's Hub there, keep a copy of the stock install and replace its package:

1. `bunx turbo run build --filter=expo-device-hub` in the repository.
2. `cd packages/expo-device-hub && npm pack --pack-destination <dir>`, which writes `expo-device-hub-<version>.tgz`.
3. In an empty `<stage>` directory: `npm init -y && npm install <dir>/expo-device-hub-<version>.tgz`.
4. `cp -a ~/.t3/tools/expo-device-hub/0.22.1 <backup>` once, then `rm -rf ~/.t3/tools/expo-device-hub/0.22.1/node_modules && cp -a <stage>/node_modules ~/.t3/tools/expo-device-hub/0.22.1/`. Keep `package.json`, `package-lock.json` and `.install-complete` in the version directory.
5. `pkill -f "expo-device-hub/0.22.1/node_modules/expo-device-hub/dist/server/cli.mjs"`. T3 Code starts the Hub again on the next device call; `device_list` then lists the phones as `physical: true`.

To go back to stock: `rm -rf ~/.t3/tools/expo-device-hub/0.22.1 && cp -a <backup> ~/.t3/tools/expo-device-hub/0.22.1`, then the same `pkill`.

## Manual checklist: unplugging

CoreDevice's disconnect drops the tunnel, but the cable and the phone's USB connection stay. Before this ships, a person runs it once with a phone that only they use:

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

- Xcode 26 on a Mac: only its compilers and SDK were tried, and an older CoreDevice was simulated with `SERVE_SIM_COREDEVICE_INFO_PLIST`. A Mac with Xcode 26 and its own CoreDevice has not run serve-sim.
- A real unplug and a Wi-Fi connection have not been tried (see the checklist).
- Servers with different state directories, and other apps that stream the phone's screen, still take a phone over, and the first server reports "iPhone disconnected". Telling a takeover from a disconnect needs the native receive loop to check that the phone is still connected when its socket fails.
- iPads have not been tried, including their display choice and frame orientation.
- agent-device on a physical iPhone: blocked on the untrusted developer certificate and T3's daemon signing settings (see the validation above).
- The Hub-served serve-sim preview cannot send input to any device.
