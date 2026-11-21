# LLP 0000: Expo Device Hub

**Type:** Explainer
**Status:** Active
**Systems:** Hub, HubClient, HubComponents, AppleUtils, AndroidUtils, ServeSim, ServeEmu, Example, CI, Release, LLP
**Role:** Root
**Author:** Claude Code (Claude Opus 5.5), directed by Krystof Woldrich
**Date:** 2026-10-02
**Revised:** 2026-11-20 (tablet page height, Claude Code); 2026-11-16 (sidebar support warning, Codex directed by Krystof Woldrich); 2026-10-03 (reviewed and made Active by Krystof Woldrich)

## Summary

Expo Device Hub lets a developer see and control iOS simulators and Android emulators in the browser. It runs as an Expo DevTools plugin inside `expo start`, or as a standalone server (`npx expo-device-hub`) [observed: `README.md`].

This monorepo contains the Hub, the browser libraries that connect to devices, and the two device servers: `serve-sim` for iOS and `serve-emu` for Android [observed: root `package.json` workspaces].

Read this document first. It tells you which package owns what, how the packages connect, and which constraints you must not simplify away. Each section names where to look next.

> **Provenance.** An agent wrote this draft from the code, the package `AGENTS.md` files, and the git history. `[observed]` claims give their source. `[confirmed]` claims name a human and a date. `[inferred]` claims are guesses that a maintainer must confirm or delete. No `[inferred]` claims remain. Krystof Woldrich reviewed this document and made it `Active` on 2026-10-03.

## Packages

| Package                                 | `Systems` name  | What it owns                                                                                                                           | Published          |
| --------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `packages/expo-device-hub`              | `Hub`           | The DevTools plugin: the dashboard UI and the device server that mounts serve-sim and serve-emu.                                       | `expo-device-hub`  |
| `packages/@expo/hub-client`             | `HubClient`     | Browser hooks and components (`DeviceScreen`, `useActiveDeviceClient`, …) that connect to serve-sim or serve-emu and paint the stream. | `@expo/hub-client` |
| `packages/@expo/hub-components`         | `HubComponents` | Dependency-free UI kit and design tokens ported from `@expo/styleguide`.                                                               | private            |
| `packages/@expo/hub-apple-utils`        | `AppleUtils`    | Lists, creates, and boots simulators through `simctl`.                                                                                 | private            |
| `packages/@expo/hub-android-utils`      | `AndroidUtils`  | Lists, creates, and boots emulators through `avdmanager`, `sdkmanager`, `emulator`.                                                    | private            |
| `packages/serve-sim/packages/serve-sim` | `ServeSim`      | iOS simulator server: Swift capture addon, HTTP and WebRTC streams, input, preview UI, CLI.                                            | `@expo/serve-sim`  |
| `packages/serve-emu/packages/serve-emu` | `ServeEmu`      | Android server: scrcpy, H.264 over WebSocket, WebCodecs UI, REST control API, CLI.                                                     | private            |
| `example`                               | `Example`       | A minimal Expo app with the plugin installed.                                                                                          | private            |

[observed: `README.md` "Repository structure", `RELEASING.md`, package directories]

Private packages that ship inside `expo-device-hub` get their changesets under `expo-device-hub` [observed: `RELEASING.md`]. Releases use changesets and the `Release` GitHub workflow; `Release` is the `Systems` name for that process [observed: `RELEASING.md`, `.changeset/config.json`].

## How the packages connect

### The plugin and its mount path

The Hub registers as an Expo DevTools plugin. `expo-module.config.json` points Expo CLI at `dist/server/index.mjs` for the server and `dist/client` for the web page [observed: `packages/expo-device-hub/expo-module.config.json`]. Everything is served under `/_expo/plugins/expo-device-hub`, which `EXPO_DEVICE_HUB_BASE_PATH` overrides [observed: `src/server/mount.ts`].

### The device servers are mounted in the Hub server

The Hub server imports the serve-sim and serve-emu middleware and mounts it in its own request handler:

- serve-sim under `/vendor/serve-sim`, through `simMiddleware` from `vendor/serve-sim/dist/middleware.js` [observed: `src/server/serve-sim.ts`].
- serve-emu under `/vendor/serve-emu`, through the middleware in `vendor/serve-emu/dist/middleware.js` [observed: `src/server/serve-emu.ts`].
- WebSocket upgrades go through the same middleware [observed: `simWebSocketHandler`, `emuWebSocketHandler`].

For iOS, serve-sim runs a helper process for each device on a local port. The Hub spawns the serve-sim CLI as a detached process when the preview root is requested and no helper state exists [observed: `ensureHelperSpawned` in `src/server/serve-sim.ts`]. The Hub passes `proxyHelpers: true`, so the browser reaches each helper's stream, control socket, and DevTools through same-origin URLs, and the helper ports stay local to the host [observed: `src/server/serve-sim.ts`; `packages/serve-sim/packages/serve-sim/README.md` "proxyHelpers"].

`vendor/` is a build output. `scripts/vendor.ts` runs `npm pack` on each package in `vendorDependencies` and unpacks it to `vendor/<name>`, so the Hub ships the same files that npm would install [observed: `packages/expo-device-hub/scripts/vendor.ts`]. Rebuild it with `bun run --filter expo-device-hub build:vendor` after you change serve-sim or serve-emu.

The Hub vendors serve-sim and serve-emu on purpose, so that its copies cannot conflict with other versions of these packages in a project that uses `expo-device-hub` [confirmed] (Krystof Woldrich, 2026-10-02). Do not replace the vendored copies with normal npm dependencies.

### The browser side

The dashboard (`src/Dashboard.tsx`) renders Expo DOM components with inline styles from `@expo/hub-components` [observed: `packages/expo-device-hub/AGENTS.md`]. It connects to devices through `@expo/hub-client`.

serve-sim and serve-emu speak different wire protocols. serve-sim streams MJPEG or H.264 and takes binary touch packets. serve-emu streams H.264 for WebCodecs and takes JSON gestures. `@expo/hub-client` hides this difference behind one client contract [observed: `README.md` "hub-client"].

The two protocols differ mainly because the servers started as separate projects [confirmed] (Krystof Woldrich, 2026-10-02).

### Mobile serve-sim layout

Below 640 CSS pixels, the serve-sim preview fits the device to the visible
viewport after subtracting safe-area padding and the measured action controls.
The displayed mobile size does not reuse the saved desktop resize preference. The floating
controls and device sidebar toggle remain; the device name, status badge, and AX
button are hidden. Input and keyboard unavailable warnings remain visible on phones; mobile fitting reserves their measured height and gap. While the phone keyboard is raised, the bottom action toolbar
is hidden and its space is given to the device; it returns when the keyboard closes.
The top-right mobile controls form one vertical toolbar, including the keyboard
toggle. It overlays the device without taking layout space. The sidebar toggle remains separate.
On mobile widths, presentation mode keeps its existing controls and fits the visible
viewport, including while the phone keyboard is raised. Mobile presentation controls
retain the keyboard capture input’s focus so exiting does not dismiss the keyboard
and trigger a second viewport refit. Tablet and desktop widths
keep their existing toolbar rendering and presentation sizing.
For flat mobile previews, the normal fitted width is retained while presentation
unmounts its controls. A single layout transform animates the device between its
normal and presentation bounds; an interrupted animation restarts from its current
visible bounds rather than its old target. The initial fit and reduced motion do
not animate. Mobile hardware artwork and its screen opening use the current layout
size in that same render; waiting for a ResizeObserver would leave their pixel
rectangles at the previous size for a frame during keyboard fitting. For the
same reason, the mobile fitted width is measured again in the commit that applies
a new page height or hides the action row; otherwise the old, taller device
overflows the keyboard-sized page and jumps up for a frame. Desktop
keeps observed dimensions for its width transition, and 3D Duo keeps its existing
animation path.
[observed: ServeSim `src/client/hooks/use-flip-layout.ts`,
`src/client/hooks/use-mobile-simulator-size.ts`, and `src/client/utils/layout-transition.ts`]
[observed: `src/client/client.tsx` and `src/client/hooks/use-mobile-simulator-size.ts`
in ServeSim; confirmed: Gabe Debes, 2026-10-23, requested mobile layout]

### Mobile Hub layout

Hub uses its own shared components, not the serve-sim viewer. Below 640px and
on short touch landscape viewports, the dashboard and viewer share visual viewport
bounds, including keyboard height and viewport panning. Keyboard detection normalizes
the visual height by its zoom scale so pinch zoom alone does not hide controls. Mobile hides the title,
keeps the sidebar reachable, and fits the device above a normal-flow action bar.
Mobile fitting does not wait for an observer to measure that bar.
The mobile viewer provides a keyboard toggle when the client supports HID text
events. It sits in the action bar directly after the Clipboard menu. The action bar is hidden while the
keyboard is up and in full screen. With the keyboard up, the sidebar toggle and the
full-screen button hide too, and the device takes that room; the phone's own keyboard
controls dismiss the keyboard. An in-page full-screen toggle is pinned to the top-right
corner, opposite the sidebar toggle, and shows a close icon while active. On a phone the
page behind the dashboard takes the color of the surface above the browser's bottom bars,
so no lighter strip shows under them. A phone's open sidebar fills the screen. Full-screen controls
preserve capture focus. The sidebar stays hidden in full screen intentionally; a browser
clipboard fallback leaves full screen before showing the inspector when a fallback
handler exists. Single-device sessions use the same sidebar
([LLP 0013](0013-hub-client-input-and-control.explainer.md#single-device-sessions)).
Consumers without a fallback handler retain presentation. Tablet and desktop stream panels retain their existing title and
padding. The shared toolbar and sidebar changes are described below. [observed: Hub `Dashboard.tsx`, HubComponents
`StreamPanel.tsx` and `StreamControls.tsx`, HubClient `useMobileViewport.ts`]
[confirmed: Gabe Debes, 2026-10-26, requested equivalent mobile behavior in Hub]
[confirmed: Billy Roh, 2026-10-29, requested the Keyboard toggle in the Clipboard pill and
the top-right Full screen button; since the toolbar became one bar
([Hub toolbar](#hub-toolbar)), the toggle keeps its place next to the Clipboard menu]

Tablet and desktop size the dashboard, its sidebar, and the server connection overlay to `100dvh`, the visible
page height. Tablet browsers make `100vh` the height with their toolbar hidden, so a `100vh` dashboard put the
end of the sidebar and the device controls below the bottom edge. In desktop Chrome, `100dvh` and `100vh` have
the same value. [observed 2026-11-20: iPad (A16) simulator, iOS 27 Safari, full-screen window: `innerHeight`
and `100dvh` 1048px, `100vh` 1123px; Pixel Tablet emulator, Android 16 Chrome, landscape: `innerHeight` and
`100dvh` 648px, `100vh` 744px; headless desktop Chrome, 1440×900 window: both 813px]

### Hub sidebar

Hub has one sidebar, on the left. It lists the simulators and emulators, then shows the
selected device's inspector below them in the same scrolling column. There is no right
sidebar, so the stream panel uses the rest of the width. The toolbar has no Theme button;
the device's appearance is the inspector's Appearance setting. [observed: Hub
`Dashboard.tsx`; HubComponents `Sidebar.tsx`, `InspectorSections.tsx`,
`StreamControls.tsx`] [confirmed: Billy Roh, 2026-10-29, requested moving the right pane
into the left pane and removing the Theme button]

#### Sidebar look

The sidebar has the look of the website's preview settings. A hairline separates each section;
a section's title row is 52px high and takes the subtle surface under the pointer; an option
is a label with its control at the right, 20px from the next option. A select is a box of
36px with 8px corners and one shared width, a switch turns blue when on, and a button is a
pill. [observed: HubComponents `CollapsibleSection.tsx`, `SidebarRow.tsx`, `Select.tsx`,
`SidebarSwitch.tsx`, `Button.tsx`; universe `SimulatorPreviewSection.tsx`,
`SimulatorPreviewOptions.tsx`, `ui/components/Select.tsx`, `ui/components/Switch` at
`d24ccaa940`] [confirmed: Krystof Woldrich, 2026-11-17, requested the website's font, sizes,
selects, sliders and buttons for the sidebar, with the Hub's own sections and options]

The device lists are the Hub's own, because the website shows one device per preview. A list
has its title with the add button at the right, and one 36px row per device with the
platform's mark, the name, and the OS version. The selected row has the info surface and
border. [observed: HubComponents `DeviceSection.tsx`, `DeviceListItem.tsx`]
[confirmed: Krystof Woldrich, 2026-11-17, gave the design frames of the lists]

#### Adding a device

The add button of a device list opens a menu of the recent devices of its platform: the
shut-down devices that the list does not show, the most recently used first, each with its OS
version. A click boots the device; the menu stays open with a spinner on its row until the
host answers, and a failed boot opens a dialog with the host's reason. The last row,
"Create new simulator" or "Create new emulator", opens a modal with the name, the OS version
and the model of a new device, and one Create button. The modal stays open while the host
creates and boots the device, and shows a failure above the button. On Android the model
comes before the OS version, because the model narrows the system images.
[observed: HubComponents `AddDeviceMenu.tsx`, `NewDeviceModal.tsx`, `DeviceSection.tsx`,
`Modal.tsx`] [confirmed: Krystof Woldrich, 2026-11-17, gave the design frames of the menu and
the modal, and asked for the two steps: the recent devices first, the modal only for a new
device]

#### Steady inspector

The inspector does not add or remove sections and rows while a device connects or
reconnects. [confirmed: Krystof Woldrich, 2026-11-17, requested that options stay displayed
and only change their value or lock]

- **Sections.** A selected device always has Current app, Device options, Stream options
  and Logs, and the sections of its platform: Accessibility, Location, Clipboard and Events
  on iOS; Camera, Accessibility, Location, Permissions and Events on Android. A section whose
  capability the device does not report says that it is not available, in place of its
  controls. [observed: `PLATFORM_SECTIONS` in `InspectorSections.tsx`]
- **Rows.** Device options has one fixed list of rows per platform. A row that the device
  cannot change now is locked: while the settings load, without a reason; while the Hub
  cannot read them, or on a device that does not have the setting, with the reason in a
  tooltip. A select whose value is not known shows a placeholder.
  [observed: `SELECT_SETTINGS`, `SWITCH_SETTINGS` and `lockReason` in `DeviceOptionsSection.tsx`]
  Stream options has a fixed list of rows per platform too: Transport, the two codec rows,
  Max size, Video FPS and Video bitrate; on iOS also MJPEG FPS and MJPEG quality; on Android
  also Source. A row that the server or the device has nothing for is locked with a reason: a
  codec of a transport that the server does not offer, an encoder setting that the client
  does not report, and the source of a device that has one source. Only the rows of the gRPC
  source follow a value: they show while that source is selected.
  [observed: `ENCODER_SETTINGS` and the Source and codec rows in `StreamOptionsSection.tsx`]
- **Kept values.** A client reports its capabilities, device settings, stream capabilities,
  stream settings, stream source, orientation and fold as absent while it connects, and again
  on each reconnect. On iOS the settings are cleared whenever the exec channel's URL or token
  changes. [observed: the settings effect in HubClient `useIosDevice.ts`] The inspector keeps
  the last value of those fields for each device and shows it, and locks the rows that hold
  a kept value until the client reports again. The kept values are only for the layout:
  commands and the fields that say whether a control can be used are always the live ones.
  [observed: `useSteadyClient.ts`]
- **The guess.** A device that has not reported yet starts with the capabilities of the last
  device of its kind that streamed, so its sections are in place before it connects. A kind
  is a platform and whether the device is physical: a physical phone does not take what an
  emulator can do. A client reads some capabilities after its stream starts, and it reports
  one that it has not read yet like one that the device does not have. So the guess holds
  for 5 seconds after the device streams. From then on only the device's own reports count,
  and a control that the device does not have goes. [observed: `GUESS_GRACE_MS` and
  `deviceKind` in `useSteadyClient.ts`]
- **A device switch.** In the render that selects another device, the client still holds the
  reports of the device before, because its adapter clears them in an effect. The inspector
  does not read the client's reports in that render, so they are not kept under the new
  device. [observed: `reportingDevice` in `useSteadyClient.ts`; the settings effects in
  HubClient `useIosDevice.ts` and `useAndroidDevice.ts`]

The website does the same for its fixed set of options: it shows every option of the
platform while the settings load and disables them.
[observed: universe `SimulatorPreviewOptions.tsx` at `d24ccaa940`] The Hub differs in one
point: it does not hide an option that the device reports as unsupported, because a row
that leaves after the first read is also a change of the list.

#### Device support warning

A device outside Hub's supported/tested set keeps an amber warning triangle in
its sidebar row. The triangle is a separate button that opens non-modal details:
it does not select or boot the device, and it is not nested inside the row's
selection button. Keyboard and touch activation use the same trigger; Escape
returns focus and outside interaction dismisses the details. The explanation is
about device-type support and testing: streaming and controls may not work as
expected, but the device can still be tried. It does not describe rendering or
GPU performance. The details anchor to the warning trigger and render in a portal
outside the sidebar's scroll container. Viewport collision handling can flip them
above the trigger; long content scrolls within the available height. They hide when
the trigger scrolls out of view. [observed: HubComponents `DeviceListItem.tsx` and
`UnsupportedDeviceWarning.tsx`]

### Hub toolbar

The toolbar under the device has the look of the website's device controls: one rounded bar
on the element surface that holds round 36px icon buttons with 20px icons, and a dark tooltip
that slides in above a button and says what the button does. The glyphs of Back, Home,
Recents, Dismiss keyboard, Screenshot and Reload are the website's.
[observed: HubComponents `StreamControls.tsx`, `ControlButton.tsx`, `Tooltip.tsx`, the
`.hub-tooltip` rules in `theme/theme.css`; universe `SimulatorPreviewControls.tsx` and
`ui/components/Tooltip` at `d24ccaa940`]
[confirmed: Krystof Woldrich, 2026-11-17, requested that the controls under the screen look
and behave like the website's]

The order follows the website: an Android device leads with Back, Home, Recents and Dismiss
keyboard, in the order of its navigation bar; Screenshot and Reload follow on both
platforms. The controls that only the Hub has come last: the Clipboard menu, the Keyboard
toggle of a phone layout, and Rotate. The inspector keeps its rows for the Android buttons.
[observed: `StreamControls.tsx`, `StreamPanel.tsx`, `DeviceOptionsSection.tsx`]

Three things differ from the website on purpose:

- The Hub's controls do not lock while the stream is not live. The website disables every
  control until the status is `streaming`. In the Hub, input can work while video fails
  ([LLP 0013](0013-hub-client-input-and-control.explainer.md#orientation)), so only Rotate
  locks, from `orientationUnavailable`, and its tooltip gives the reason.
- A button under the pointer takes the hover surface. The website's quaternary hover color
  is the color of the bar itself, so its hover does not show.
  [observed: `--expo-theme-button-quaternary-hover` and `--expo-theme-background-element`
  are both `slate-3` in `@expo/styleguide` 14.2.0 `expo-theme.css`]
- Screenshot and the Clipboard menu show a spinner in place of their icon while their action
  runs. The website does this for Screenshot only; it has no Clipboard menu.

### DeviceKit hardware artwork

Hardware-button sprites follow the alignment in Apple's DeviceKit profile.
For `align: center`, horizontal offsets are relative to the body center, including
Home buttons on older iPhones and iPads. [observed: ServeSim `src/devicekit-chrome.ts`
and the `phone` and `tablet` DeviceKit `chrome.json` profiles]

### Direction: one device protocol

The goal is to unify the serve-sim and serve-emu protocols. Until then, every new feature must behave the same on iOS and Android, so that unification stays possible [confirmed] (Krystof Woldrich, 2026-10-02). See [constraint 10](#same-behavior).

### Direction: flat package layout

The plan is to flatten the nested `packages/serve-sim/packages/serve-sim` and `packages/serve-emu/packages/serve-emu` folders, and to remove the duplicate READMEs, agent files, and other files that the nesting causes [confirmed] (Krystof Woldrich, 2026-10-02). Until that happens, treat the nested layout as temporary: do not build new tooling or paths that depend on it.

## Constraints you must not simplify away

Each item names the code that depends on it. Do not "clean up" this code without reading the source first.

1. <a id="sim-base-path"></a>**serve-sim needs the full mount path as `basePath`.** serve-sim writes `basePath` into the URLs it returns to the client (grid, exec-ws, stream). A shorter value breaks the iOS client without an error [observed: comment on `SIM_BASE_PATH` in `src/server/serve-sim.ts`].
2. <a id="hub-client-separate"></a>**`@expo/hub-client` is a separate published package** so the Expo dashboard website can use the same code to show devices [observed: `README.md` "hub-client"]. Do not move its code into the plugin. Its API is not frozen: the package is in alpha, and the website pins an exact version, so breaking changes are allowed when they are necessary [confirmed] (Krystof Woldrich, 2026-10-02).
3. <a id="ui-matches-website"></a>**The Hub UI must match the Expo dashboard website.** Use the tokens and the `Button` from `@expo/hub-components`; never hard-code colors, sizes, radii, or shadows. The `@expo/styleguide` React components cannot be imported, because their index pulls in `next/link`, which Metro cannot bundle. That is why `@expo/hub-components` keeps its own ports [observed: `packages/expo-device-hub/AGENTS.md`].
4. <a id="emu-input-path"></a>**serve-emu writes input directly to the scrcpy control socket.** Do not use `adb shell input`; it is too slow for agent workflows [observed: `packages/serve-emu/AGENTS.md` "Runtime Assumptions"].
5. <a id="emu-auth"></a>**serve-emu binds to loopback by default.** A non-loopback bind requires a token unless `--unsafe-no-auth` is passed. The token gate runs before routing, so new routes are covered. Never put the token in `/health`, `/api`, error bodies, or reconnect URLs [observed: `packages/serve-emu/AGENTS.md` "Server and API Guidance"].
6. <a id="emu-protocol"></a>**[LLP 0008](0008-serve-emu-protocol.spec.md) is the source of truth for scrcpy framing.** The scrcpy server version is pinned in `scripts/fetch-scrcpy.ts`. Change the pin, the reference, and the parser fixtures together [observed: `packages/serve-emu/AGENTS.md` "scrcpy Protocol Notes"].
7. <a id="sim-test-isolation"></a>**serve-sim tests never touch another session's simulator.** `bun run test` puts an `xcrun` shim on `PATH` that refuses `simctl`. `bun run test:e2e` requires `SERVE_SIM_TEST_UDID` and a private state directory. This is because other agents may keep simulators running on the same machine [observed: `packages/serve-sim/AGENTS.md` "Commands"]. CI builds the package and fixtures once with pinned Xcode 26, then shares that archive with isolated unit shards and separate Xcode 26/27 Simulator jobs. Each runtime splits the `*.e2e.test.*` files over two Simulator jobs, one for `*.slow.e2e.test.ts` and one for the rest, and each job runs its files one at a time without rebuilding. A PR runs these jobs when it is ready for review, and a draft only with the `ci-ready` label. A separate Xcode 27 build of the package and fixtures runs the same files on the Xcode 27 image every night and on a PR with the `xcode-27` label; [LLP 0014](0014-serve-sim-xcode-support-and-ci.decision.md) states the support promise [observed: `.eas/workflows/sim-test.yml`, `.eas/workflows/sim-test-xcode27.yml`, `.eas/functions/restore-sim-test-build/function.yml`, `.eas/functions/test-sim-runtime/function.yml`].
8. <a id="sim-proxy-upgrades"></a>**With `proxyHelpers`, WebSocket upgrades must reach the serve-sim middleware.** If they do not, the page still shows video over HTTP, but simulator input and DevTools stop working [observed: `packages/serve-sim/packages/serve-sim/README.md` "proxyHelpers"]. In the Hub, `simWebSocketHandler` does this.
9. <a id="native-reload"></a>**The serve-sim N-API addon loads once per process.** After a native rebuild, restart any running serve-sim process before you test [observed: `packages/serve-sim/AGENTS.md` "Native build notes"].
10. <a id="same-behavior"></a>**A new feature behaves the same on iOS and Android.** Design it for both servers and give it the same behavior on both, even where the wire protocols differ today. A feature that works one way on serve-sim and another way on serve-emu works against the protocol unification [confirmed] (Krystof Woldrich, 2026-10-02).

## History that still shapes the code

- serve-sim is an Expo-maintained fork of [EvanBacon/serve-sim](https://github.com/EvanBacon/serve-sim) [observed: `packages/serve-sim/packages/serve-sim/README.md`]. It was vendored on 2026-06-10, became a git submodule on 2026-07-09, and moved into this repo in #79 (2026-09-23). It is published as `@expo/serve-sim` from this repo since #125 [observed: git history].
- serve-emu came from `expo/serve-emu` and moved into this repo in #78 (2026-09-09) [observed: git history, PR #78].
- Both moves kept the upstream directory layout, which is why the packages sit at `packages/serve-sim/packages/serve-sim` and `packages/serve-emu/packages/serve-emu` [observed: PR #78 and #79 descriptions]. This layout is temporary; see [Direction: flat package layout](#direction-flat-package-layout).
- Only serve-sim is published on its own, as `@expo/serve-sim`, because people used it before `expo-device-hub` existed. serve-emu stays private, and there is no plan to publish it as `@expo/serve-emu`; the Hub ships it vendored [confirmed] (Krystof Woldrich, 2026-10-02).
- The servers moved into this repo so that one PR can change all the projects at once. This makes development faster and stops the implementations in the packages from diverging [confirmed] (Krystof Woldrich, 2026-10-02).

## Why one LLP corpus for the whole repo

The packages are tightly coupled, so one corpus at the repo root covers all of them, not one corpus per package [confirmed] (Krystof Woldrich, 2026-10-02). One number sequence means `@ref LLP NNNN` resolves the same way from every package.

## Where to look next

| Topic                                                      | Source                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| serve-sim video pipeline and recording                     | [LLP 0001](0001-serve-sim-video-pipeline.explainer.md)          |
| serve-sim WebRTC signaling and control                     | [LLP 0002](0002-serve-sim-webrtc-architecture.explainer.md)     |
| serve-sim HTTP routes, auth, CORS, WebSockets              | [LLP 0003](0003-serve-sim-http-api.spec.md)                     |
| Hinge controls for iOS and Android and display selection   | [LLP 0004](0004-serve-sim-hinge-controls.explainer.md)          |
| serve-sim network capture and redaction                    | [LLP 0005](0005-serve-sim-network-capture.explainer.md)         |
| How Simulator.app forwards scroll (reverse-engineered)     | [LLP 0006](0006-serve-sim-scroll-injection.research.md)         |
| serve-sim capability loader                                | [LLP 0007](0007-serve-sim-capability-loader.explainer.md)       |
| serve-sim CLI startup and app readiness                    | [LLP 0011](0011-serve-sim-session-startup.explainer.md) (Draft) |
| serve-emu scrcpy framing, control packets, `SEMU` metadata | [LLP 0008](0008-serve-emu-protocol.spec.md)                     |
| serve-emu hardware H.264 encoder spike                     | [LLP 0009](0009-serve-emu-hardware-encoder-spike.research.md)   |
| serve-sim clipboard: pasteboard API, Paste, Copy           | [LLP 0010](0010-serve-sim-clipboard.explainer.md)               |
| Hub UI rules and tokens                                    | `packages/expo-device-hub/AGENTS.md`                            |
| serve-sim commands, tests, definition of done              | `packages/serve-sim/AGENTS.md`, `packages/serve-sim/REVIEW.md`  |
| serve-emu layout and auth                                  | `packages/serve-emu/AGENTS.md`                                  |
| Releases                                                   | `RELEASING.md`                                                  |

LLPs 0001–0009 were moved here from the package `docs/` folders and from `Sources/ServeSimCapabilityLoader/DESIGN.md`. Agent instructions, READMEs, and process docs stay in their packages.

## Known drift

- The root `README.md` still calls `packages/serve-sim` "Vendored source for `@expo/serve-sim`", but the package is now maintained and published from this repo [observed: #79, #125].
- The root `README.md` lists `packages/expo-serve-emu`, but that directory does not exist. It was merged into `serve-emu` in `599175f5` [observed: `ls packages`, git history].

#244 fixes both. Remove this section when #244 merges.

## Open questions for the maintainer

None at this time.
