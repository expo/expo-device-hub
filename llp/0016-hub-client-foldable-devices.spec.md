# LLP 0016: HubClient foldable devices

**Type:** Spec
**Status:** Draft
**Systems:** HubClient, HubComponents, Hub
**Author:** Claude Code (Claude Opus 5.5), directed by Krystof Woldrich
**Date:** 2026-10-21
**Revised:** 2026-11-04 (Android fold adapter, Codex gpt-6.1-sol); 2026-11-03 (the native hinge observation wins over the last command; `confirmed` says whether it reached the request; no face-down command); 2026-11-09 (ordinary-device screen/physical observations, Codex directed by Gabe Debes); 2026-11-10 (unknown interface orientation follows the raw frame shape; Claude Code, directed by Gabe Debes); 2026-11-11 (`unavailable`, and folds during a recording that follows them; Claude Code, directed by Krystof Woldrich)
**Related:** LLP 0000, LLP 0004, LLP 0013

## Summary

`@expo/hub-client` describes every foldable device with one contract: `DeviceClient.fold` for fold state and commands, `DeviceClient.capabilities.fold` for the commands that a device accepts, and display roles (`cover`, `inner`) for the displays of a foldable. Each backend adapter maps its own protocol onto the contract. The iOS adapter maps serve-sim's iPhone Duo hinge protocol. The Android adapter maps serve-emu's `/api/fold` without placeholder values.

> **Provenance.** Claude Code wrote this draft while it implemented the contract. `[observed]` claims give their source. `[confirmed]` claims name a human and a date. The design choices under [Decisions](#decisions) are Claude Code's proposals, and human review is pending. File paths are relative to `packages/@expo/hub-client/src`, unless the text gives a path from the repository root.

## Direction

- The public hub-client API describes foldable devices in general, not only the iPhone Duo. iPhone Duo items stay where they map to other foldables, such as the poses. Breaking changes are allowed [confirmed] (Krystof Woldrich, through an orchestrating Claude Code agent, 2026-10-21). The API is alpha (LLP 0000 [constraint 2](0000-expo-device-hub.explainer.md#hub-client-separate)).
- hub-client provides the device controls and the streams, and nothing else. Renderers, such as the 3D preview, are consumers [confirmed] (Krystof Woldrich, 2026-10-21; see [LLP 0004](0004-serve-sim-hinge-controls.explainer.md#3d-preview-in-the-hub)).
- A feature behaves the same on iOS and Android (LLP 0000 [constraint 10](0000-expo-device-hub.explainer.md#same-behavior)). The contract therefore names no serve-sim or serve-emu value.

## Fold state and commands

`DeviceClient.fold` is `null` for a device that does not fold. For a foldable it has [observed: `DeviceFold` in `types.ts`]:

| Field         | Meaning                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `angle`       | Hinge angle in degrees, between the display sides of the two halves: 180 is flat, a smaller angle folds the displays inward (0 is shut), and a fold-out hinge goes past 180. Undefined until reported.  |
| `pose`        | The named pose in effect; `null` for a custom angle; undefined until reported.                                                                                                                          |
| `pending`     | A command waits for the device's acknowledgement. `angle` and `pose` show the request until the device confirms it.                                                                                     |
| `error`       | The last failed command. The next command clears it.                                                                                                                                                    |
| `unavailable` | Optional. Why commands are unavailable now, as a `DeviceRecordingLockReason`; absent while they are available. Only Android sets it, while a recording could end with a fold.                           |
| `tableMode`   | Optional group `{ enabled, available }`. Present only when `capabilities.fold.tableMode` is true.                                                                                                       |
| `physical`    | Optional group `{ pose, faceDown }`: how the device is held, apart from the hinge. Present only when the backend reports it. `faceDown` is undefined while the backend has not reported enough to tell. |
| `setControl`  | Sends a `FoldControlCommand`: `angle`, `pose`, or `tableMode`.                                                                                                                                          |
| `observe`     | Optional. Reports each command as `FoldCommandEvent`s: `requested`, `sent`, `acknowledged`, `confirmed`, `failed`, `rejected`, `reset`, and `rotated`.                                                  |

An optional group is absent when the device does not have the feature. Inside a group, an unknown value stays undefined; it never becomes `false`. A consumer can then keep what it last knew. For example, the 3D model keeps its face-down framing while `physical.faceDown` is undefined, as serve-sim's client does when Table Mode or the physical orientation is unknown [observed: `useDuoFraming.ts`; `knownNotFaceDown` in serve-sim's `src/client/hooks/use-duo-framing.ts`]. A device never fills a group with placeholder values. `tableMode` is present exactly when `capabilities.fold.tableMode` is true. The iOS adapter adds both groups together with `capabilities.fold`, so before the helper reports its hinge the iPhone Duo's `fold` has neither [observed: `fold` in `useIosDevice.ts`].

## Capabilities

`DeviceClient.capabilities.fold` follows the other capability groups: `false`, or an object [observed: `DeviceFoldCapabilities` in `types.ts`]:

- `angle`: `{ min, max }` in degrees, measured as `fold.angle` is, or `false` for a device that applies poses only. The iPhone Duo and #352's Android emulators accept 0–180.
- `poses`: the poses that the device can apply, each with the hinge angle that it sets.
- `tableMode`: the device has Xcode's persistent table state.

There is no face-down command. serve-sim's protocol offers one (`physical`), but nothing in hub-components or the Hub sent it, and on iOS it also changes Table Mode, so it was the least portable command. Krystof Woldrich removed it from the contract [confirmed] (Krystof Woldrich, 2026-11-03). Adding it back later does not break consumers. `fold.physical.faceDown` stays: it reports what the device observes, and the 3D model frames the cover from it.

`capabilities.fold` is `false` until the backend reports a hinge that it can move. `fold` can be non-null at that time. For example, the iPhone Duo is recognized from its DeviceKit chrome before its first screen config [observed: `isDuo` and `foldCapabilities` in `useIosDevice.ts`]. Fold settings, the pose shortcuts, and the 3D model's hinge handles use only what `capabilities.fold` lists [observed: `FoldSettings.tsx`, `useDeviceKeyboard.ts`, `FoldableDeviceScreen.tsx` in `packages/@expo/hub-components/src`]. The iOS adapter also rejects a command that `capabilities.fold` does not offer. It sets `error` and emits `rejected`, so a consumer that checks only `fold` cannot reach the backend too early. Unlike `failed` after a failure from the device, `rejected` leaves the other commands alone, because a command already sent still gets its reply. The 3D model therefore keeps the preview of a pending pose [observed: `foldCommandOffered` in `fold.ts`; `setHingeControl` in `useIosDevice.ts`; `useDuoFraming.ts`].

## Pose vocabulary

`FOLD_POSES` is `closed`, `open`, `laptop`, `book`, and `tent`, in the order of Xcode Device Hub's pose shortcuts [observed: `fold.ts`; LLP 0004, "Device Hub's hidden Action Bar"]:

| Pose     | Meaning                                        | Android name (posture)         |
| -------- | ---------------------------------------------- | ------------------------------ |
| `closed` | Folded shut; the cover display is in use.      | `closed`                       |
| `open`   | Unfolded flat; the inner display is in use.    | `opened`                       |
| `laptop` | Half open on a table, with a horizontal hinge. | `half_opened`, tabletop        |
| `book`   | Half open in the hand, with a vertical hinge.  | `half_opened`, book            |
| `tent`   | Half open, standing on its two outer edges.    | `tent` (fold-out devices only) |

The angle that each pose sets belongs to the device, so it is in `capabilities.fold.poses`, not in the vocabulary. The iPhone Duo's Tent is 80° [observed: `DUO_POSE_ANGLES` in `hinge-control.ts`]. The 3D model in `@expo/hub-components/foldable` reads the preset angles from `capabilities.fold.poses`, so the iPhone Duo's angles are written down once, in the iOS adapter [observed: `useDuoFraming.ts`].

## Pose shortcuts

Option+Shift+1–5 always mean `FOLD_POSES[0]`–`FOLD_POSES[4]`, so a key keeps its pose on every device and matches the labels in Fold settings. On a device with `capabilities.fold`, the keyboard hook consumes the key. It sends the pose only when `capabilities.fold.poses` lists it; another digit does nothing [observed: `useDeviceKeyboard.ts`]. The orchestrator chose to consume the key for an absent pose (2026-10-21), as #352 does.

## Display identity

A foldable's displays are named by role: `DeviceDisplayId` is `cover` or `inner` [observed: `types.ts`]. The role is the identity in every public place: `DeviceDisplay.id`, `TouchSample.display`, `MultiTouchSample.display`, `ScrollSample.display`, the `sent` event's `display`, and `ScreenSize.display`.

serve-sim's display IDs (1 for the cover, 3 for the inner display) stay inside the iOS adapter [observed: `DUO_DISPLAY_FOR_PANEL` in `duo/duo-fold.ts`] and inside the iPhone Duo model, which keys its geometry on them [observed: `duo-displays.ts` in `packages/@expo/hub-components/src/foldable`].

## Screen

`ScreenSize` publishes `width`, `height`, `orientation`, `framesUpright`, `inputUnavailable`, and `display`. `display` names the display that the size and orientation describe, as native readback confirmed it. Only a foldable sets it [observed: `simScreenSize` in `screen-config.ts`].

Confirmed ordinary iOS devices can also publish optional `screenOrientation` and
`deviceOrientation`. The first is native interface orientation; the second is
physical pose (`portrait`, `pud`, `landscape-left`, `landscape-right`, `faceup`,
`facedown`). A present null means unknown; absence means the helper lacks this
observation contract. In this mode, `screen.orientation` follows the native
interface and becomes undefined when that observation is unknown. It never
falls back to the last rotation command. `displayScreen` supplies physical
framing, and `streamGeometry` maps interface pixels/input to that framing.
When the interface orientation is unknown, the raw frame shape decides, as in
the legacy rule: landscape pixels already face the framing, and portrait pixels
are taken as unturned content and turned to the framing. `homeIndicatorEdge` uses the same interface orientation.
Duo retains its existing projected screen contract; these ordinary-device
fields do not alter its geometry
[observed: `simScreenSize` in `screen-config.ts`, `orientation.ts`].

serve-sim's screen config also carries the hinge state and the display ID. The iOS adapter keeps that config as `SimScreenConfig` and publishes the projection. A hinge move alone keeps the same `screen` object [observed: `publicScreen` in `useIosDevice.ts`].

`DeviceClient.displayCorners` stays a client field. It describes the display in `screen.display`. Only the flat view reads it, and the flat view shows one display at a time; the 3D model takes its glass from the model [observed: `PhoneFrame.tsx`].

## Mapping

### iPhone Duo

| Contract                          | serve-sim (0x82 screen config, 0x10 command, 0x90 reply)                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capabilities.fold`               | Set when `supportsHingeAngle` is true, or when it is absent and `hingeAngle` is reported                                                                                |
| `.angle` / `.poses`               | `{ 0, 180 }` / all five, at Device Hub's angles                                                                                                                         |
| `.tableMode`                      | `true`                                                                                                                                                                  |
| `fold.angle` / `fold.pose`        | `hingeAngle` / `hingePose`, with the pending request; see [Native observation](#native-observation)                                                                     |
| `fold.tableMode`                  | `{ enabled: tableMode, available: tableModeAvailable }`                                                                                                                 |
| `fold.physical`                   | `{ pose: physicalPose, faceDown }`: face down with Table Mode; undefined while `tableMode` or `physicalOrientation` is unknown and the other field does not rule it out |
| `screen.display`, `displays[].id` | `screenId` 1 → `cover`, 3 → `inner`                                                                                                                                     |
| `{ control: "tableMode" }`        | Wire `{ control: "table" }`                                                                                                                                             |

[observed: `useIosDevice.ts`, `hinge-control.ts`, `screen-config.ts`]

While `physical.faceDown` is undefined, a half-open iPhone Duo keeps the panel that native readback reports as the active display. The 3D model keeps its face-down framing in that state, so the presented panel and the framing agree. Commands still elect the display from their own state [observed: `duoIntendedScreen` in `duo/duo-fold.ts`].

#### Native observation

`hingeAngle`, `hingePose`, `tableMode`, and `physicalOrientation` are the state of the last successful command. serve-sim also sends `observedDeviceState`, the hinge angle, physical orientation, and Table Mode that it reads from the simulator [observed: `screenConfig` in serve-sim's `src/device-session.ts`]. When the config has it, the observation replaces the command fields in the `fold.angle`, `fold.pose`, `fold.tableMode`, and `fold.physical` rows above, and in the display that the fold elects (`displays[].active`), as in serve-sim's own client. `capabilities.fold` still reads the command fields `supportsHingeAngle` and `hingeAngle`, so an observation alone never offers fold controls [observed: `hingeReported` in `useIosDevice.ts`]. In the replaced rows, `fold.pose` is the preset that the observation matches, else `null`, `tableMode.available` follows the observed angle and orientation, and a field that the observation omits is unknown [observed: `observedScreenConfig` in `screen-config.ts`; `previewScreenConfig` in serve-sim's `src/client/simulator/screen-config-state.ts`]. A fold made with the Simulator's own controls changes only the observation, so without this `fold` would not show it: the helper sets the command fields from its own commands and from a native read when it seeds or refreshes the hinge, and a new observation sets only `observedDeviceState` [observed: the `0x10` handler, `hydrateHingeState`, and the device-state listener in serve-sim's `src/device-session.ts`]. A config that changes only the observation is a new config [observed: `screenConfigsEqual` in `screen-config.ts`].

The preview of a command holds only the fields that commands set, and the fold reads every other field from the observation. `fold.physical.pose` compares a new observed preset with the one observed while the last command was pending, so a readback that still lags that command does not undo it [observed: `setHingeControl` and `observedPoseRef` in `useIosDevice.ts`].

The helper sends the command's config before its native readback moves. A Table Mode command at an observed 90.2° therefore still reaches its 500 ms limit, which compares the preview with the command's config [observed: `setHingeControl` and `hingeCommanded` in `useIosDevice.ts`]. An observed angle matches a request or a preset within 1°; serve-sim uses 1° for requests and 0.5° for presets, and one value keeps `confirmed.observed` and `fold.pose` consistent [observed: `OBSERVED_ANGLE_TOLERANCE` in `hinge-control.ts`]. A command's preview holds until the observation reaches it, or for 500 ms after the command's config first matched; a later config, such as another viewer's, does not restart or cancel the 500 ms, while a new command starts its own 500 ms and a reset clears it [observed: `hingeDeadlinePreview` in `useIosDevice.ts`]. serve-sim's client also holds it for 500 ms, counted from the acknowledgement. The `confirmed` event comes when the preview ends. Its `observed` is true when the observation reached the request, or when the config has no observation and the command's fields match; it is false when the 500 ms ran out, and the fold then shows the observation, not the request [observed: `isHingePreviewObserved` in `hinge-control.ts` and `useIosDevice.ts`; `use-duo-framing.ts` in serve-sim's `src/client/hooks`].

### Android emulators

The Android adapter maps serve-emu's `/api/fold` onto the same `client.fold` and `capabilities.fold` used by iOS. It adds no renderer state or placeholder optional groups [observed: `useAndroidFold.ts`, `android-fold.ts`].

| Contract                     | Android mapping                                                   |
| ---------------------------- | ----------------------------------------------------------------- |
| `fold`                       | Non-null after a supported hinge is reported; null without one    |
| `capabilities.fold`          | False until a verified 0–180° range is reported                   |
| `.angle`                     | `{ min: 0, max: 180 }`                                            |
| `.poses`                     | `closed` 0°, `book` 90°, `open` 180°                              |
| `.tableMode`                 | False                                                             |
| `fold.angle`                 | `hingeAngle`, with the pending choice until the write answers     |
| `fold.pose`                  | The exact preset angle, or null for custom; undefined until known |
| `fold.tableMode`, `physical` | Absent                                                            |
| `displays`, `screen.display` | Null and absent; Android streams one display at a time            |

[observed: `android-fold.ts`, `useAndroidFold.ts`, `useAndroidDevice.ts`]

The adapter sends `POST { hingeAngle }` for both angle commands and presets. Only commands listed in capabilities are accepted. Laptop, Tent and Table Mode are not offered. The device's physical orientation is not inferred from a hinge angle [observed: `android-fold.ts`].

One latest-choice writer per device URL serializes HTTP writes, including across token changes, and replaces a waiting choice with the latest one. Polls that overlap a command and results from a retired device or token cannot replace current state. Commands have optimistic previews and expose pending and error state; the response supplies the authoritative angle. Reads poll every five seconds, continue after unsupported answers, and preserve object identity when unchanged. Requests and body reads time out after 30 seconds; writes are not retried [observed: `useAndroidFold.ts`, `android-fold.ts`, `latest-writer.ts`].

An unknown hinge range offers no controls, because it cannot distinguish an inward-folding device from a fold-out profile. Fold-out ranges are also not offered in this iteration: serve-emu's angle request contract is limited to 0–180°. Existing posture-only REST commands still work with an unknown range [observed: `androidFoldCapabilities` in `android-fold.ts`; `setHingeAngle`, `setFoldPosture` in ServeEmu `src/fold.ts`].

The shared dashboard and keyboard hook use capabilities to show the slider and only the offered pose choices and shortcuts. There are no Android 3D preview controls, and Android's flat preview sizing stays unchanged. Native fold controls are disabled while `fold.unavailable` is set: the recording lock, unless the recording reports that it follows folds ([LLP 0018](0018-serve-emu-fold-recording.spec.md#fold-during-a-recording)). The adapter also rejects commands then and rechecks a queued choice before sending it [observed: `FoldSettings.tsx`, `DeviceOptionsSection.tsx`, `useDeviceKeyboard.ts`, `PhoneFrame.tsx` in HubComponents; `useAndroidFold.ts`; `foldRecordingLock` in `screen-recording.ts`].

Krystof Woldrich chose to close #256 and resume #352 with the shared APIs on main [confirmed: Krystof Woldrich, 2026-11-04]. The old `DeviceHinge` and optional `controls` API from #352 are replaced by this mapping.

## Decisions

These are Claude Code's choices while it implemented the direction above. Human review is pending.

- **`fold`, not `hinge`.** The object holds more than the hinge: the pose, Table Mode, and how the device is held. The angle is one field. The name also matches serve-emu's `/api/fold` and the Hub's Fold settings [observed: `src/shared/api-contracts.ts` in serve-emu; `FoldSettings.tsx`].
- **Opt-in capabilities.** #352 proposed `DeviceHinge.controls`, where `undefined` meant every iPhone Duo control. An explicit `capabilities.fold` follows the other capability groups, and a new backend offers nothing by default.
- **Commands named after their capability.** `tableMode` replaces serve-sim's wire name `table`, so one name is used for the capability, the command, and the state group.
- **Helpers removed from the public API.** `HINGE_POSES` (with Device Hub's angles and labels), `hingeControlState`, `isHingeControlCommand`, `isTableModeAvailable`, `HingeControlState`, and `HingePhysicalOrientation` described serve-sim's protocol. The iOS adapter keeps what it uses; `isHingeControlCommand` and `isTableModeAvailable` had no caller in hub-client and were removed [observed: `git grep` on #432's head 5721b06f]. A private `isTableModeAvailable` came back for the [native observation](#native-observation).
- **The 3D model keeps the iPhone Duo's name.** `FoldableDeviceScreen` and the `duo-*` modules in `@expo/hub-components/foldable` render only Xcode's iPhone Duo model.

## Open questions

1. Are `cover` and `inner` the right role names? They came from the orchestrator's analysis (Claude Code), not from a maintainer. `main` instead of `inner` would also fit a fold-out device whose only display is on the outside. Neither name fits a dual-screen device.
2. `deviceModelUrl` does not say which model it is. Only the iPhone Duo has one today. A second device with a model needs a kind, so that a consumer picks the right renderer.
3. Should an Android adapter set `screen.display` from serve-emu's posture (`closed` → `cover`)? No consumer reads it on Android today.
