# LLP 0020: Physical iOS devices

**Type:** Spec
**Status:** Draft
**Systems:** ServeSim, Hub, HubClient, HubComponents, AppleUtils
**Author:** Claude Code (claude-opus-5-5), directed by Thomas Girardier
**Date:** 2026-11-19
**Related:** LLP 0000, LLP 0001, LLP 0003, LLP 0011

## Summary

A paired iPhone or iPad looks like a simulator to every viewer: the Hub, serve-sim's preview,
and other clients of serve-sim. It uses serve-sim's video formats and its input socket. This
document covers the parts in TypeScript: how the device is listed, which serve-sim features it
has, and how its session ends when the device goes away. The native screen source that streams
the device is another part of the same project and is not described here.

> **Provenance.** Claude Code wrote this draft while it implemented the listing, the feature
> gate, and the session end. The direction (the names, the public id, the features of version 1,
> the stream requirements) was given in the task [confirmed] (Thomas Girardier, 2026-11-19).
> `[observed]` claims give their source. Paths are relative to the repository root.

## Listing

The Hub and serve-sim's grid both list the iPhones and iPads that
`xcrun devicectl list devices --json-output <file>` reports, beside the simulators.
[observed: `packages/@expo/hub-apple-utils/src/list-physical-devices.ts`,
`packages/serve-sim/packages/serve-sim/src/physical-devices.ts`]

- A device is listed when it is real hardware (`reality: "physical"`), its platform is iOS or
  iPadOS, it is paired, and Developer Mode is on. It is listed also when its tunnel is
  disconnected: opening it connects it.
- Its public id is the hardware UDID, such as `00008101-0016603236F0801E`, in routes, the grid,
  and the Hub's device list. Only native code uses the CoreDevice identifier.
- It is always booted. Neither the Hub nor serve-sim boots, shuts down, or removes it, as for a
  physical Android device: the Hub hides Shut down and Remove for every physical device, and
  serve-sim's `/grid/api/shutdown` refuses one.
- The Hub marks it `physical: true`. serve-sim's grid rows carry `kind: "physical"` or
  `kind: "simulator"`, as serve-emu's carry `kind`.
- A device that cannot stream is still listed, unsupported, with a reason: `"needs iOS 27"`
  when its OS is older than iOS 27, and `"needs Xcode 27"` when the CoreDevice framework on this
  Mac is older than 642 (its `CFBundleShortVersionString`). The Hub's sidebar warning shows the
  reason. [observed: `UnsupportedDeviceWarning.tsx`]
- serve-sim cannot depend on the private `@expo/hub-apple-utils`, because it is published on its
  own, so it has its own copy of the devicectl rules. Both copies parse the same fixture.

## Feature gate

A physical device has the live screen, touch, keyboard, Home, screenshots, and recording. It has
none of the features that need a simulator, through simctl, CoreSimulator, or a dylib injected
into the simulator's apps. One table decides this: `DEVICE_FEATURES` and
`unavailableDeviceFeatures` in serve-sim's `src/device-features.ts`. A device is physical when its
id is a hardware UDID.

| Feature          | What it covers                                                |
| ---------------- | ------------------------------------------------------------- |
| `clipboard`      | Paste, Copy, and the pasteboard route                         |
| `apps`           | App install, launch, stop, files, URLs, icons, media          |
| `permissions`    | App permissions                                               |
| `location`       | Simulated location                                            |
| `logs`           | Device logs and crash reports                                 |
| `deviceSettings` | Appearance, accessibility and UI settings, simulator controls |
| `appInjection`   | The injected dylibs: camera injection and network capture     |
| `devtools`       | Web Inspector                                                 |
| `accessibility`  | The accessibility tree                                        |
| `foregroundApp`  | The foreground app                                            |
| `activity`       | Activity metrics                                              |
| `hinge`          | Hinge and fold controls                                       |
| `rotate`         | Rotate                                                        |
| `lifecycle`      | Booting and shutting down                                     |

serve-sim already uses "capability" for an injected dylib (LLP 0007), so the table says
"feature".

- **Routes.** The middleware refuses a route of a missing feature with 409 and
  `{ "error": "<reason>" }` before it routes, for its own routes and the `/helper/<device>/…`
  routes. Host actions refuse the same way before they run anything; each action names its
  feature in `HOST_ACTION_FEATURES`, which the compiler keeps complete.
- **Clients.** The preview config carries `deviceKind` and `unavailableFeatures`, a map from each
  missing feature to its reason, such as "Location is not available on a physical device.". It
  leaves out `inputPaste` and `inputCopy` when the clipboard is missing. `@expo/hub-client`
  reports each missing feature as an absent capability, so the Hub's inspector shows the section
  as not available (LLP 0000, Steady inspector). serve-sim's preview shows a tool of a missing
  feature as a card with the reason, and disables Logs and Web Inspector.
- A server without `unavailableFeatures` is an older one; a client then keeps every feature.

## Device end

When a physical device goes away, by an unplugged cable or a lost Wi-Fi connection, its session
ends, as serve-emu marks a session whose video stream ended terminal.
[observed: `markTerminal` in `packages/serve-emu/packages/serve-emu/src/middleware.ts`]

- The native screen source reports the end once through `NativeCapture.subscribeEnd`, with
  `{"reason":"device-disconnected","message":"iPhone disconnected"}`, also to a listener that
  subscribes after the end. Only a device that serve-sim cannot boot is observed.
- The session closes every viewer's input socket with code 4410 and the reason as its close
  reason, withdraws the device's state file, and records the reason. For
  `device-disconnected` the reason is "iPhone disconnected"; for another end, the native
  `message`.
- Until the device is started again through `/grid/api/start`, `/api?device=<udid>` and the
  `/api/events` feed answer `{ "device": "<udid>", "ended": { "reason": "<reason>" } }` in place
  of a config. It has no `url`, so an older client reads it as no device.
- `@expo/hub-client` shows the reason as the device's error and does not start the device again
  in that connection. Selecting the device again starts it again.

## Open questions

- serve-sim's own preview does not yet show the end reason; it shows the device as gone.
- The Hub's inspector shows its generic "not available" note, not serve-sim's reason.
