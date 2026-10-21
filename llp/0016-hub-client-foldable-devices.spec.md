# LLP 0016: HubClient foldable devices

**Type:** Spec
**Status:** Draft
**Systems:** HubClient, HubComponents, Hub
**Author:** Claude Code (Claude Opus 5.5), directed by Krystof Woldrich
**Date:** 2026-10-21
**Related:** LLP 0000, LLP 0004, LLP 0013

## Summary

`@expo/hub-client` describes every foldable device with one contract: `DeviceClient.fold` for fold state and commands, `DeviceClient.capabilities.fold` for the commands that a device accepts, and display roles (`cover`, `inner`) for the displays of a foldable. Each backend adapter maps its own protocol onto the contract. The iOS adapter maps serve-sim's iPhone Duo hinge protocol. An Android adapter can map serve-emu's `/api/fold` without placeholder values.

> **Provenance.** Claude Code wrote this draft while it implemented the contract. `[observed]` claims give their source. `[confirmed]` claims name a human and a date. The design choices under [Decisions](#decisions) are Claude Code's proposals, and human review is pending. File paths are relative to `packages/@expo/hub-client/src`, unless the text gives a path from the repository root.

## Direction

- The public hub-client API describes foldable devices in general, not only the iPhone Duo. iPhone Duo items stay where they map to other foldables, such as the poses. Breaking changes are allowed [confirmed] (Krystof Woldrich, through an orchestrating Claude Code agent, 2026-10-21). The API is alpha (LLP 0000 [constraint 2](0000-expo-device-hub.explainer.md#hub-client-separate)).
- hub-client provides the device controls and the streams, and nothing else. Renderers, such as the 3D preview, are consumers [confirmed] (Krystof Woldrich, 2026-10-21; see [LLP 0004](0004-serve-sim-hinge-controls.explainer.md#3d-preview-in-the-hub)).
- A feature behaves the same on iOS and Android (LLP 0000 [constraint 10](0000-expo-device-hub.explainer.md#same-behavior)). The contract therefore names no serve-sim or serve-emu value.

## Fold state and commands

`DeviceClient.fold` is `null` for a device that does not fold. For a foldable it has [observed: `DeviceFold` in `types.ts`]:

| Field        | Meaning                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `angle`      | Hinge angle in degrees, between the display sides of the two halves: 180 is flat, a smaller angle folds the displays inward (0 is shut), and a fold-out hinge goes past 180. Undefined until reported.  |
| `pose`       | The named pose in effect; `null` for a custom angle; undefined until reported.                                                                                                                          |
| `pending`    | A command waits for the device's acknowledgement. `angle` and `pose` show the request until the device confirms it.                                                                                     |
| `error`      | The last failed command. The next command clears it.                                                                                                                                                    |
| `tableMode`  | Optional group `{ enabled, available }`. Present only when `capabilities.fold.tableMode` is true.                                                                                                       |
| `physical`   | Optional group `{ pose, faceDown }`: how the device is held, apart from the hinge. Present only when the backend reports it. `faceDown` is undefined while the backend has not reported enough to tell. |
| `setControl` | Sends a `FoldControlCommand`: `angle`, `pose`, `tableMode`, or `faceDown`.                                                                                                                              |
| `observe`    | Optional. Reports each command as `FoldCommandEvent`s: `requested`, `sent`, `acknowledged`, `confirmed`, `failed`, `reset`, and `rotated`.                                                              |

An optional group is absent when the device does not have the feature. Inside a group, an unknown value stays undefined; it never becomes `false`. A consumer can then keep what it last knew. For example, the 3D model keeps its face-down framing while `physical.faceDown` is undefined, as serve-sim's client does when Table Mode or the physical orientation is unknown [observed: `useDuoFraming.ts`; `knownNotFaceDown` in serve-sim's `src/client/hooks/use-duo-framing.ts`]. A device never fills a group with placeholder values. `tableMode` is present exactly when `capabilities.fold.tableMode` is true. The iOS adapter adds both groups together with `capabilities.fold`, so before the helper reports its hinge the iPhone Duo's `fold` has neither [observed: `fold` in `useIosDevice.ts`].

## Capabilities

`DeviceClient.capabilities.fold` follows the other capability groups: `false`, or an object [observed: `DeviceFoldCapabilities` in `types.ts`]:

- `angle`: `{ min, max }` in degrees, measured as `fold.angle` is, or `false` for a device that applies poses only. The iPhone Duo and #352's Android emulators accept 0–180.
- `poses`: the poses that the device can apply, each with the hinge angle that it sets.
- `tableMode`: the device has Xcode's persistent table state.
- `faceDown`: the device accepts the `faceDown` command.

`capabilities.fold` is `false` until the backend reports a hinge that it can move. `fold` can be non-null at that time. For example, the iPhone Duo is recognized from its DeviceKit chrome before its first screen config [observed: `isDuo` and `foldCapabilities` in `useIosDevice.ts`]. Fold settings, the pose shortcuts, and the 3D model's hinge handles use only what `capabilities.fold` lists [observed: `FoldSettings.tsx`, `useDeviceKeyboard.ts`, `FoldableDeviceScreen.tsx` in `packages/@expo/hub-components/src`].

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

`ScreenSize` has only platform-neutral fields: `width`, `height`, `orientation`, `inputUnavailable`, and `display`. `display` names the display that the size and orientation describe, as native readback confirmed it. Only a foldable sets it [observed: `simScreenSize` in `screen-config.ts`].

serve-sim's screen config also carries the hinge state and the display ID. The iOS adapter keeps that config as `SimScreenConfig` and publishes the projection. A hinge move alone keeps the same `screen` object [observed: `publicScreen` in `useIosDevice.ts`].

`DeviceClient.displayCorners` stays a client field. It describes the display in `screen.display`. Only the flat view reads it, and the flat view shows one display at a time; the 3D model takes its glass from the model [observed: `PhoneFrame.tsx`].

## Mapping

### iPhone Duo

| Contract                          | serve-sim (0x82 screen config, 0x10 command, 0x90 reply)                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capabilities.fold`               | Set when `supportsHingeAngle` is true, or when it is absent and `hingeAngle` is reported                                                                                |
| `.angle` / `.poses`               | `{ 0, 180 }` / all five, at Device Hub's angles                                                                                                                         |
| `.tableMode` / `.faceDown`        | `true` / `supportsPhysicalOrientation`                                                                                                                                  |
| `fold.angle` / `fold.pose`        | `hingeAngle` / `hingePose`, with the pending request                                                                                                                    |
| `fold.tableMode`                  | `{ enabled: tableMode, available: tableModeAvailable }`                                                                                                                 |
| `fold.physical`                   | `{ pose: physicalPose, faceDown }`: face down with Table Mode; undefined while `tableMode` or `physicalOrientation` is unknown and the other field does not rule it out |
| `screen.display`, `displays[].id` | `screenId` 1 → `cover`, 3 → `inner`                                                                                                                                     |
| `{ control: "tableMode" }`        | Wire `{ control: "table" }`                                                                                                                                             |
| `{ control: "faceDown", value }`  | Wire `{ control: "physical", value: "facedown" \| "faceup" }`                                                                                                           |

[observed: `useIosDevice.ts`, `hinge-control.ts`, `screen-config.ts`]

### Android emulators

hub-client does not map serve-emu's fold yet; `fold` is `null` and `capabilities.fold` is `false` on Android [observed: `useAndroidDevice.ts`]. #352 (draft, by jiunshinn) implements the adapter. This is the mapping that the contract allows without placeholders:

| Contract                     | serve-emu `/api/fold`                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `capabilities.fold`          | `false` unless `supported` is true                                                                               |
| `.angle`                     | `hingeRange` with #352's `POST { hingeAngle }`; `false` on main, which accepts only `POST { posture }`           |
| `.poses`                     | #352: `closed` 0°, `book` 90°, `open` 180°. Main: `closed` and `open`                                            |
| `.tableMode` / `.faceDown`   | `false` / `false`                                                                                                |
| `fold.angle`                 | `hingeAngle`                                                                                                     |
| `fold.pose`                  | The offered pose whose angle equals `hingeAngle`, else `null` (#352's rule); or `closed` / `open` from `posture` |
| `fold.tableMode`, `physical` | Absent                                                                                                           |
| `displays`, `screen.display` | `null` and absent: the emulator shows one display at a time                                                      |

[observed: `packages/serve-emu/packages/serve-emu/src/fold.ts` and `src/shared/api-contracts.ts` on main at 2dbd9287; #352 at 8279f0b2]

serve-emu's `half_opened` posture is not a pose by itself. At 90° it is `book`; at another angle it is `null` (custom). `flipped` and `tent` occur on fold-out profiles, whose hinge moves from 180° to 360° [observed: #352's LLP 0004 section]. #352 shows no fold for them. The contract can describe them later with `angle: { min: 180, max: 360 }` and the poses they offer.

#256 (draft, by jiunshinn) reads the posture as a string device setting, `fold`. With this contract, main's posture-only serve-emu maps to `capabilities.fold = { angle: false, poses: { closed, open }, tableMode: false, faceDown: false }`, and Fold settings shows a pose select without a slider [observed: `FoldSettings.tsx`]. The `fold` device setting is then not needed.

## Decisions

These are Claude Code's choices while it implemented the direction above. Human review is pending.

- **`fold`, not `hinge`.** The object holds more than the hinge: the pose, Table Mode, and how the device is held. The angle is one field. The name also matches serve-emu's `/api/fold` and the Hub's Fold settings [observed: `src/shared/api-contracts.ts` in serve-emu; `FoldSettings.tsx`].
- **Opt-in capabilities.** #352 proposed `DeviceHinge.controls`, where `undefined` meant every iPhone Duo control. An explicit `capabilities.fold` follows the other capability groups, and a new backend offers nothing by default.
- **Commands named after their capability.** `tableMode` and `faceDown` replace serve-sim's wire names `table` and `physical`, so one name is used for the capability, the command, and the state group.
- **Helpers removed from the public API.** `HINGE_POSES` (with Device Hub's angles and labels), `hingeControlState`, `isHingeControlCommand`, `isTableModeAvailable`, `HingeControlState`, and `HingePhysicalOrientation` described serve-sim's protocol. The iOS adapter keeps what it uses; `isHingeControlCommand` and `isTableModeAvailable` had no caller in hub-client and were removed [observed: `git grep` on #432's head 5721b06f].
- **The 3D model keeps the iPhone Duo's name.** `FoldableDeviceScreen` and the `duo-*` modules in `@expo/hub-components/foldable` render only Xcode's iPhone Duo model.

## Open questions

1. Are `cover` and `inner` the right role names? They came from the orchestrator's analysis (Claude Code), not from a maintainer. `main` instead of `inner` would also fit a fold-out device whose only display is on the outside. Neither name fits a dual-screen device.
2. `deviceModelUrl` does not say which model it is. Only the iPhone Duo has one today. A second device with a model needs a kind, so that a consumer picks the right renderer.
3. Should an Android adapter set `screen.display` from serve-emu's posture (`closed` → `cover`)? No consumer reads it on Android today.
4. Is the `faceDown` command needed in the public API? It replaces #432's `physical` command, which serve-sim's protocol offers, but nothing in hub-components or the Hub sends it or reads `capabilities.fold.faceDown` [observed: `git grep` on this branch]. Keeping it costs one capability flag; removing it keeps the contract minimal.
