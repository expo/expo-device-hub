# Hinge controls and display selection

The iPhone Duo's physical pose combines a **hinge angle** with the device's
orientation. Three shortcuts below the phone select Fully folded, Partially open,
and Fully open. At the top of **Simulator** settings in the Tools sidebar, the
Fold pose dropdown offers those same options plus Laptop and Tent. Hinge angle
and Table Mode follow as standard settings rows, with the decimal angle input
beside the slider. Partially open uses Device Hub's Book pose.
Both control locations share the same pending and confirmed state.

| Pose | Hinge angle |
| --- | --- |
| Fully folded (Closed) | 0° |
| Partially open (Book) | 90° |
| Fully open (Open) | 180° |
| Laptop | 90° |
| Tent | 80° |

Laptop and Book have the same hinge angle but different physical orientations.
The live slider covers 0–180°, and the numeric input accepts decimal angles.
Changing the angle preserves the current physical orientation, releases Table
Mode, and clears the selected preset. Rotating the device releases Table Mode
after applying the new orientation. Frames still follow the active display and
any orientation restrictions imposed by the foreground app.

The Table Mode toggle controls the simulator's persistent table state. Tent
enables it automatically; the other presets disable it.

Confirmed hinge angles, named poses, and Table Mode values reflect successful
commands in the current serve-sim session. serve-sim does not monitor the live
hinge sensor for changes made externally in Device Hub. The streamed display
and its orientation still follow native display readback.

Table Mode eligibility requires a known physical orientation, established by
choosing a preset. An independent rotation invalidates that knowledge because
its screen orientation can differ from physical orientation. Choose a preset
again to restore Table Mode eligibility after rotating. Angle adjustments keep
the known physical orientation and update eligibility for the new angle.

Duo defaults to **3D**. The **Preview mode** selector in Simulator settings
switches between 2D and 3D and remembers the choice in the browser. The 3D view
loads Apple's `V68.usdz` from a local Xcode installation, with the live stream
on its cover or inner display. Folding, unfolding, and
switching poses animate continuously, including when a new preset interrupts a
transition. Closed presents the cover straight toward the viewer, and Open
presents the inner display straight toward the viewer. The view uses native
orientation once when connecting. Rotate controls and pose presets choose the
device's orientation. In Closed, Book (Partially open), and Open, hinge edits
smoothly turn the cover or inner screens toward the viewer while retaining the
chosen portrait/landscape orientation. Display switches and delayed orientation
updates never rotate the model.
Laptop has a level base and horizontal hinge; Tent presents the outer cover
screen with both halves descending from a horizontal ridge. In these two tabletop
modes, slider adjustments preserve the view through the closed and open endpoints.
Laptop folds around its stationary base; Tent folds symmetrically beneath its ridge.
The browser's reduced-motion preference applies pose changes immediately.

Drag either outer-edge handle to fold or unfold the 3D preview. Near closed
(30° or less), only the original handle remains visible. Both handles also
support arrow keys, Home to close, and End to open.

Raw framebuffer pixels use a fixed mapping to each physical panel: no rotation
for the cover, and a clockwise 90° rotation in canvas coordinates for the inner
display. This matches the inner panel's native 270° mounting in Y-up coordinates.
App rotation is already present in the captured pixels, so the renderer does not
apply an additional correction from app orientation or the model's viewing angle.
Stream orientation updates affect the live display, independently of the saved
model view. Rotate controls turn that view immediately without waiting for a frame.
Native frames fill their corresponding panels without changing aspect ratio;
touch coordinates use the inverse of the same mapping. The inactive display
keeps its last decoded frame while the simulator switches between cover and inner
screens. As soon as a pose requests the other display, updates to the departing
panel stop so its shutdown frames cannot replace that cached image.

Like the 2D DeviceKit artwork, the model and textures stay in the host's Xcode
installation. No model, converted copy, or offline model-editing tools are
bundled in the repository. The server serves the original USDZ at
`grid/api/devicekit-model`; the browser loads its geometry and materials and
binds the live displays and hinge in memory. No request to Apple is needed.
The model is resolved relative to Xcode's `Contents` directory at:

```text
SharedFrameworks/DeviceKit.framework/Versions/A/PlugIns/CoreDevicePopDeviceKitExtension.devicekitplugin/Contents/Resources/V68.usdz
```

`DEVELOPER_DIR` or `xcode-select -p` takes priority. If that Xcode lacks the
asset, serve-sim checks installed apps in `/Applications` and `~/Applications`.
An absent/incompatible model or WebGL failure uses the 2D preview; selecting 3D
retries loading. AX inspection also uses the flat view to align its overlays.
Laptop and Tent still apply their native settings in 2D, while their folded
device shapes are shown only in 3D.

Each control waits for acknowledgement. While dragging, the latest queued
angle replaces intermediate values; selecting a preset replaces queued slider
changes. Disconnects, failures, and timeouts discard queued changes so they
are not replayed on reconnect or on another device.

Protocol clients can select the active physical surface without moving the
hinge by sending the acknowledged hinge command `{ control: "physical", value:
"faceup" | "facedown" }`. The screen config advertises
`supportsPhysicalOrientation` when this is available, and reports the confirmed
`physicalOrientation`. Face down is accepted only while the hinge is partially
open because it uses the simulator's Table Mode sensor to elect the outer
surface. The 3D preview follows it to the cover, as it does for Tent.

With the simulator focused, Option+Shift+1–5 (⌥⇧1–⌥⇧5) select Closed, Open,
Laptop, Book, and Tent. Command+1–5 remain available for browser tab switching.

The existing CLI uses degrees and keeps its three angle aliases:

| Alias | CLI | Angle | UIKit status |
| --- | --- | --- | --- |
| Fold | `serve-sim hinge fold` | 0° | `closed` |
| Half Fold | `serve-sim hinge half` | 90° | `partiallyOpen` |
| Unfold | `serve-sim hinge unfold` | 180° | `fullyOpen` |

The CLI also accepts an angle, such as `serve-sim hinge 120 -d <udid>`. A command
waits for an acknowledgement and reports failures instead of assuming that
writing to the input socket changed the device.

## APIs inside an iOS app

The iOS 27.1 SDK provides `UIHinge`, `UIHinge.Status`, and `UIHingeInteraction`.
Attach an interaction to a view to receive the initial hinge state and later
updates. `update.hinge` can be nil when the view leaves a hierarchy that provides
hinge updates. `UIHinge.angle` is in **radians**; its status is `unknown`, `closed`,
`partiallyOpen`, or `fullyOpen`. The SDK recommends using status when only the
posture matters, because angle-update frequency and precision are system policy.

These are observation APIs for apps. They do not fold a physical device.

SwiftUI offers `onHingeChange`, whose closure receives the previous and current
hinge context. Apple calls this the **Hinge API**. Use hinge data for interactions
and effects; use scene geometry, arrangement, and region APIs for layout.

Source: `UIKit.framework/Headers/UIHinge.h` and `UIHingeInteraction.h` in the local
Xcode 27.1 beta iPhoneSimulator SDK, Apple's [UIHinge documentation](https://developer.apple.com/documentation/uikit/uihinge),
and [Leverage multiple displays and scenes on iPhone Duo](https://developer.apple.com/videos/play/tech-talks/111464/).

## Device Hub's hidden Action Bar

Xcode 27.1's Device Hub has an internal Action Bar for iPhone Duo. Enable it,
then quit and reopen Device Hub:

```sh
defaults write com.apple.dt.Devices com.apple.dt.coredevicepop.useInternalV68ActionBar -bool true
```

The bar exposes a continuous 0–180° hinge slider, five pose presets, rotation
controls, and Table Mode. The preset shortcuts and physical states are:

| Shortcut | Pose | Angle | Physical orientation | Table Mode |
| --- | --- | --- | --- | --- |
| ⌘1 | Closed | 0° | Portrait | Off |
| ⌘2 | Open | 180° | Portrait | Off |
| ⌘3 | Laptop | 90° | Landscape left | Off |
| ⌘4 | Book | 90° | Portrait | Off |
| ⌘5 | Tent | 80° | Face down | On |

These orientations describe the physical device, independently of the active
panel's native rotation. A Laptop preset therefore differs from sending a 90°
hinge angle alone. Non-Tent presets release Table Mode before applying their
hinge angle and orientation. Tent sets 80°, then face down, then Table Mode.
serve-sim activates the outside display with Table Mode while holding a
landscape-left physical orientation, then waits for its orientation readback
before sending face down. This gives iOS time to rotate the cover instead of
retaining the previous portrait interface orientation. Apps that lock their
orientation still enter Tent after a bounded wait. The final physical state
remains face down.
Device Hub's hinge-slider editing callback releases Table Mode, and its
rotation control sends the new orientation before releasing Table Mode.

Table Mode is a persistent simulated state. Device Hub enables its control for
these combinations:

| Hinge state | Physical orientations |
| --- | --- |
| Closed | Landscape left or right |
| Partially open | Portrait, upside down, landscape left or right, face down |
| Open flat | Portrait |

The installed Action Bar exposes one hinge-angle slider. Its other physical
controls are presets and rotation controls; no independent pitch, roll, or yaw
sliders were found.

Device Hub changes the rotation control from Rotate Right to Rotate Left while
Option is held. serve-sim's decimal input provides fine angle adjustment directly.

A second hidden preference controls how Device Hub sends a requested angle:

```sh
defaults write com.apple.dt.Devices com.apple.dt.coredevicepop.disableHingeInterpolation -bool true
```

With this enabled, Device Hub sends the target angle in one event instead of
sweeping through intermediate angles. It does not change the 3D model or
sliders. This is a Device Hub setting; serve-sim sends the requested angle
directly and does not depend on either preference.

The pose values, Table Mode availability, and preference strings above come
from the installed Xcode 27.1 beta binary:

```text
/Applications/Xcode-27.1.0-Beta.app/Contents/SharedFrameworks/DeviceKit.framework/Versions/A/PlugIns/CoreDevicePopDeviceKitExtension.devicekitplugin/Contents/MacOS/CoreDevicePopDeviceKitExtension
```

The hidden `HingeStatePoster` wallpaper visualizes the hinge with a circular
progress indicator and state labels: 0.00 Closed, 0.50 Partial, and 1.00 Fully
Open. The installed iOS 27.1 runtime contains its extension at this path relative
to the `runtimeRoot` reported by
`xcrun simctl list runtimes --json`:

```text
System/Library/ExtensionKit/Extensions/HingeStatePoster.appex
```

Its bundle identifier is `com.apple.Posters.HingeStatePoster`. The extension
declares a Lock Screen poster with `PRSupportsGallery = false`.

## Device Hub's simulation transport

DeviceHub's internal names are `closed`, `partiallyOpen`, and `openFlat`.
Its hinge slider sends a private CoreDevice vendor-defined HID event:

- Capability: `HIDVendorDefined.send(usagePage:usage:version:data:)`.
- Usage page `0xff61`, usage `0x5b`, version `0`.
- Data: `IOCFSerialize(dictionary, 1)` of the following dictionary:

```text
provider = com.apple.Virtualization.VirtualMachines
source = hinge-slider-control
type = range
value = angle in degrees, clamped to 0...180
```

This is a private Xcode API, separate from the public UIKit APIs.

DeviceHub's orientation picker uses the same transport with
`source = orientation-picker-control`, `type = enum`, and a value of `portrait`,
`pud`, `landscape-left`, or `landscape-right`. Duo ignores the legacy GSEvent
rotation path. The picker describes physical pose, so serve-sim converts the
requested screen orientation using the active panel's profile `nativeRotation`
(0° outside, 270° inside). Native display readback remains authoritative when an
app restricts rotation.

Table Mode uses a different report: a
`CoreDeviceUtilities.CustomButtonReport` with packed usage `0x005bff61`, sent
through `UniversalHIDService` to `HIDServiceID.avpCustom`. Its `down` field is the
desired enabled state. It must be retained until the next explicit change,
rather than sent as a button press followed immediately by release.

## Selecting the stream's display

The hinge angle alone is not a reliable substitute for the active display ID.
Display changes can arrive after the sensor angle changes. Both framebuffers
remain allocated, so choosing the largest surface can stream an inactive panel.
Legacy `SimScreenProperties.backlight` was also observed to retain stale values
after a fold. CoreDevice's display information supplies the authoritative active
display and orientation; capture and touch routing must follow the same display.

The 3D preview retains one model while the active stream changes between the
cover and inner displays. Pointer input is projected onto the visible active
display and mapped back to its streamed coordinates.

In the flat framed view used for AX inspection, the closed screen uses
DeviceKit's `phone15` frame; half-folded and fully open use the same `phone14`
inner-display frame. The frame and hardware buttons rotate around the stream.
The inner frame's button PDFs declare `/Rotate 270`; both asset dimensions and
PNG conversion must apply that page rotation.

## Touch transport

The Duo's legacy Indigo inner-screen target (`0x40000003`) is disconnected.
Sending input there can abort `backboardd` with “Unable to dispatch event through
disconnected service.” This was a serve-sim transport mismatch, not an inability
of the simulator to accept inner-screen input.

Foldable touch input now uses CoreDevice's `UniversalHIDServiceCapability` and
Apple's `UniversalHID.DigitizerReport` / `DigitizerContact` constructors. Reports
go to touchscreen service `0x100 + screenID`: `0x101` for the cover and `0x103`
for the inner display. Each contact retains its identity until lift. Taps,
drags, wheel-generated drags, and two-finger gestures share this path; the
selected service stays pinned through each gesture's final report. Input waits
for capture to identify a panel. Capability lookup retries transient startup
failures and never falls back to the disconnected legacy inner service.

The new path is restricted to profiles with exactly two integrated displays;
virtual outputs (such as CarPlay) do not count. Nonfoldable devices keep their
original Indigo target (`0x32`), Down events for both begin and move, and legacy
rotation, without CoreDevice capability queries. Legacy keyboard
and button input can coexist with Universal HID touch reports on the Duo.

For independent checks on Xcode 27.1 beta:

```sh
xcrun devicectl device info displays --device <udid>
xcrun devicectl device motion hinge-angle --device <udid>
```

The motion command is a monitor. Its stdout can contain valid angle samples even
when a command timeout causes the final JSON report to record a timeout.
