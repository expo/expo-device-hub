# LLP 0015: Physical device preview

**Type:** Explainer
**Status:** Draft
**Systems:** Hub, HubClient, HubComponents, AppleUtils, AndroidUtils
**Author:** Codex, directed by aPinix (human review pending)
**Date:** 2026-10-28
**Related:** [LLP 0000](0000-expo-device-hub.explainer.md), [LLP 0013](0013-hub-client-input-and-control.explainer.md)

## Scope and governing constraints

Physical Android discovery and physical iPhone/iPad discovery and preview are
the scope. The governing foundation is
[LLP 0000](0000-expo-device-hub.explainer.md); the existing input presentation is
described in the in-flight [LLP 0013](0013-hub-client-input-and-control.explainer.md).
The applicable constraints are LLP 0000#ui-matches-website,
LLP 0000#hub-client-separate, LLP 0000#emu-input-path, and LLP 0000#same-behavior.

## Independent discovery

Android command-line tools and ADB are queried independently. A missing
`avdmanager`, an unreadable AVD config, or a phone disconnecting during `getprop`
does not erase the other discovered devices. The first failure still appears in
the result's `error` field [observed: `hub-android-utils/src/list-devices.ts`].

Xcode `xcdevice list` lists physical iPhones and iPads separately from `simctl`.
Only available, nonignored physical iOS devices enter Hub's running-device list.
The hardware model code distinguishes iPhones from iPads even after a user rename.
Remembered unavailable phones, simulators, and watches are excluded;
failure does not remove simulator results [observed: `hub-apple-utils/src/physical-devices.ts`,
`expo-device-hub/src/server/devices.ts`]. Physical devices have no Hub shutdown or
delete control [observed: `Dashboard.tsx`].

`xcdevice` replaces the initial `devicectl` state filter because a connected USB
iPhone was available to `xcdevice` and usbmuxd while CoreDevice reported it as
disconnected [observed: local device discovery on 2026-10-28].

A failed physical iOS query retains the last successful result for at most one
minute, with the error still reported. This avoids resetting a working preview
when Xcode times out. A successful query replaces that result immediately
[observed: `hub-apple-utils/src/physical-devices.ts`].

The sidebar keeps the existing Simulators and Emulators groups and adds separate
iOS Devices and Android Devices groups. Only the virtual-device groups offer
creation controls [observed: `hub-components/src/dashboard/Sidebar.tsx`].
USB/Wi-Fi icons use Xcode's interface and ADB's USB field or network serial format;
unknown transports have no icon. The existing discovery broadcaster fingerprints
transport and model changes as well as arrivals/departures, so they update without
a page reload [observed: `device-list-websocket.ts`, `list-devices.ts`, `DeviceListItem.tsx`].

## Physical iOS transport

The optional Rust Node-API backend is fetched from a pinned commit of Callstack's
MIT-licensed mobile development plugin and verified with SHA-256. Source stays in
ignored build output; a small committed patch removes telemetry and renames the
crate, retaining its license notices and pinned dependencies. Build it with `build:ios-device`;
ordinary simulator and Android builds do not require Rust [observed:
`expo-device-hub/native/ios-device/NOTICE.md`, `scripts/build-ios-device.ts`].

The backend uses CoreDevice displayservice and UniversalHID over the existing
trusted device connection, with no app installation. This is a private protocol
and may change with Xcode/iOS releases [observed: `native/ios-device/src/addon.rs`].
The native bounded queue, decoder generations, per-stream stop IDs and held-touch
release follow the reference implementation [observed: `addon.rs`, `input.rs`, `queue.rs`].

The capture backend selects usbmuxd USB first, then network. Xcode-only wireless
pairing can make a device discoverable without exposing it through usbmuxd. In
that case preview reports the detected model and explains how to enable Finder's
Wi-Fi device access after connecting by USB. It does not call a detected iPad a
disconnected iPhone. In the local iPad check, Finder Wi-Fi was already enabled;
reconnecting USB refreshed the missing usbmuxd network entry [observed: local iPad test and
`scripts/ios-device.patch`, `src/server/physical-ios.ts`].

### Session ownership

The Hub's existing HTTP authentication gate covers `/api/ios-device/*`. The
adapter also rejects foreign browser origins, validates connected device IDs,
honors platform/session restrictions, limits concurrent captures and request
bodies, and expires abandoned sessions. Only a generation with a keyframe can
accept input. Normalized Hub coordinates are converted to the native backend's
pixel coordinates before dispatch. Closing one viewer stops only that viewer's
native stream [observed: `src/server/physical-ios.ts`].

Without a session token, physical iOS requests must use the existing serve-sim
loopback host allowlist (`localhost`, `127.0.0.1`, or `::1`). Matching `Origin` to
the request URL alone is insufficient because its host comes from the request.
Other hosts require the Hub's session-token gate before entering the adapter;
same-origin checks still apply [observed: `physical-ios.ts`, `index.ts`,
`serve-sim-options.ts`; Devin review of PR #507 on 2026-10-28].

The native patch reads SpringBoard's interface orientation at the beginning of
each gesture and maps displayed coordinates to the portrait digitizer. This is
needed for landscape iPads; the display stream is already rotated, while
UniversalHID coordinates are not. Video recovery releases native contacts, so the
browser drops remaining move/up events from the old generation [observed:
`scripts/ios-device.patch`, `hub-client/src/usePhysicalIosDevice.ts`].

Native recovery can also advance the generation after the browser's last read.
A stale touch is rejected with HTTP 409 and requests a fresh keyframe; it does not
close the capture. This was reproduced during the iPhone Wi-Fi touch check
[observed: `scripts/ios-device.patch`, `physical-ios.test.ts`].

The browser long-polls compressed HEVC batches and decodes them with WebCodecs.
It serializes touch writes, coalesces unsent moves, bounds decoder backlog, closes
VideoFrames after drawing, and closes its session when the selection changes.
Starting a new physical iOS connection clears the previous canvas so a failed
connection cannot display another device's screen [observed: `usePhysicalIosDevice.ts`].

CoreDevice video includes right/bottom encoder padding beyond the HEVC crop.
The adapter optionally reads the primary display's native size and fits it within
the encoded dimensions, preserving orientation and scale. The canvas crops to
that content size, which also supplies the input coordinate dimensions. If display
metadata is unavailable, the encoded size remains the fallback. Physical screens
reuse Hub's existing corner clipping, including serve-sim's iPad proportions
[observed: `scripts/ios-device.patch`, `usePhysicalIosDevice.ts`, `PhoneFrame.tsx`].

Physical iOS supports screen viewing, single-contact taps/drags, and the existing
local screenshot control. App reload, keyboard, multi-touch, hardware buttons, app metadata, accessibility,
logs, recording, device settings and simulated location are not offered by this
adapter [observed: `hub-client/src/usePhysicalIosDevice.ts`, `NOOP_DEVICE_CLIENT`].
The physical iOS Reload toolbar button is disabled along with Home and Rotate.
Reload no longer reconnects the video capture, which did not reload the running
app [observed: `StreamControls.tsx`, `StreamPanel.tsx`, `usePhysicalIosDevice.ts`;
Devin review of PR #507 on 2026-10-28].

## Review questions

- Maintainers need to decide how to build/distribute the optional Rust addon in
  releases and whether to share it with the reference project [inferred].
- The native adapter dependency and Android regression fix can be
  reviewed as separate contributions before an upstream PR [inferred].
- This fork has no fallback decoder for browsers lacking HEVC; it shows an
  actionable error [observed: `usePhysicalIosDevice.ts`].

## Validation in the fork

Codex ran the standard build, typecheck, lint, LLP reference check, affected package
tests, native tests, and an npm pack dry run on an Apple Silicon Mac on 2026-10-28.
The affected suites passed 1,562 tests; the native suite passed 69, including
stale input generation recovery and display padding cases. One existing client
timing test failed once during earlier parallel checks, then passed in isolation
and subsequent complete suite runs. The package dry run included the
native addon and its license notices. After the toolbar cleanup, build, typecheck,
lint, LLP references and all 122 HubComponents tests passed again, and the live
wireless iPad preview was checked in the browser [observed: local command results
and browser check by Codex].

Before PR submission, the root `bun run test` command also passed all six configured
package test tasks: 2,812 passed, three Windows-only cases skipped. The unchanged
Android hardware H.264 encoder test timed out on the first full run, then passed
in isolation and on the full-command rerun. The exact PR-template build and
typecheck commands passed as well. An identical mocked Samsung discovery test in
isolated exported source trees failed against upstream `9688df9f` (empty device
list) and passed against branch `f1530eff`. This is follow-up regression evidence;
a failing-test-first commit sequence was not recorded [observed: local command
results by Codex on 2026-10-28].

Live previews were checked with an iPhone 16 Pro, iPad Pro M5, and Samsung Galaxy
S25 FE. A Samsung tap launched an app; the landscape iPad camera zoom control
responded after the orientation correction. The follow-up unlocked iPad check
opened King Score's Settings and returned to its home screen using Hub touch input
over USB and, after unplugging, over Wi-Fi. The iPad's cropped canvas measured
2736 × 2052, removing the padded bottom strip while retaining working touch input
and the existing tablet corner proportions. The iPhone canvas measured
1206 × 2622 after cropping; iPhone and Samsung previews retained their existing
corner styles. Human review is still pending.
@aPinix also reports manually using the iPad Pro 13-inch (M5), iPhone 16 Pro, and
Samsung Galaxy S25 FE [confirmed: @aPinix, 2026-10-28].
Hardware screenshots and identifiers are not committed [observed: local browser
checks by Codex; human review pending].

For the Devin review fixes, Codex first reproduced the enabled physical iOS Reload
button and acceptance of matching foreign Host/Origin values with regression tests.
After the fix, all six root test tasks passed (2,824 passed, three Windows-only
skips; three unaffected tasks reused cached results). Build, typecheck, lint and
LLP checks passed. No new physical-device or native test run was needed for these
toolbar and HTTP admission changes [observed: local command results by Codex on
2026-10-28].
