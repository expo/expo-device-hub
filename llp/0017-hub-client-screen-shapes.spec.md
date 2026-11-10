# LLP 0017: HubClient screen shapes

**Type:** Spec
**Status:** Draft
**Systems:** HubClient, HubComponents
**Author:** Claude Code (Claude Opus 5.5), directed by Krystof Woldrich
**Date:** 2026-11-05
**Revised:** 2026-11-10
**Related:** LLP 0000, LLP 0016

## Summary

`@expo/hub-client/shapes` gives a device screen the outline of the real device: the superellipse corners of each iPhone, iPad, and Pixel model, and one outline per display of the iPhone Duo. The expo.dev website and the Hub dashboard both use it, so a device looks the same in both places, live and in recordings.

> **Provenance.** Claude Code wrote this draft while it implemented the entry point. `[observed]` claims give their source. `[confirmed]` claims name a human and a date. File paths are relative to `packages/@expo/hub-client/src`.

## Direction

- The shapes move from the expo.dev website (expo/universe#32697, #32698, #32682, #32807, #32890, #33238) into hub-client, so the website and the Hub dashboard share them [confirmed] (Krystof Woldrich, 2026-11-05).
- The public API is a component, `DeviceShape`, that takes a device client like `DeviceScreen` does. Other props override what the client reports [confirmed] (Krystof Woldrich, 2026-11-05).
- The display of a multi-display device is part of selecting the shape, together with the platform and the model [confirmed] (Krystof Woldrich, 2026-11-05).
- An app that does not use shapes must not bundle the shape table or the shape code [confirmed] (Krystof Woldrich, 2026-11-05).

## Public surface

| Export                                                                                 | Role                                                                                                                                                                              |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DeviceShape`                                                                          | A `div` clipped to the shape. It takes `client`, and `platform`, `model`, `display`, `orientation`, and `shape` override the client. `aspectRatio` and `insetPx` adjust the clip. |
| `useScreenShape(source)`                                                               | The same lookup as `DeviceShape`, for layout: the shape as the viewer sees it, or null.                                                                                           |
| `resolveScreenShape({ platform, model, display })`                                     | The portrait shape of a model, or null.                                                                                                                                           |
| `hasDisplayScreenShapes({ platform, model })`                                          | Whether a model has a shape per display.                                                                                                                                          |
| `SCREEN_SHAPES`                                                                        | Every device shape by name, for picking one by hand, such as for the `shape` prop.                                                                                                |
| `rotateScreenShape`, `screenShapeOrientation`                                          | Turning a portrait shape with the device.                                                                                                                                         |
| `screenShapeClipPath`                                                                  | The CSS for an element that cannot be wrapped.                                                                                                                                    |
| `screenShapeGeometry`, `interpolateScreenShapeGeometry`, `screenShapeGeometryClipPath` | Placing a shape in part of an element and blending two shapes, such as the iPhone Duo switch in a recording.                                                                      |

The entry has real device shapes only. It has no builder for a shape that is not a device, and no mask image (see [Decisions](#decisions)).

`DeviceShape` only clips. It draws nothing and does not turn, so `DeviceScreen` inside it keeps its pointer mapping [observed: expo/universe#32682 turns only the bezel image for the same reason].

## Separate entry

The shapes are the `./shapes` subpath export, built to `dist/shapes/index.mjs`. `index.ts` does not import `shapes/`, and the package keeps `sideEffects: false`, so a bundler drops the whole table for an app that imports only the main entry. A test bundles the main entry and checks that no shape data is in the output [observed: `__tests__/screen-shapes.test.tsx`].

## Model names

A model is the name that identifies its hardware exactly, not the name a running device reports:

- iOS: the simulator device type name from `xcrun simctl list devicetypes`, such as `iPhone 17 Pro`. It matches without case and surrounding spaces. The simulator names the iPhone XR `iPhone Xʀ` [observed: expo/universe#32697].
- Android: the AVD hardware profile id, an AVD's `hw.device.name`, such as `pixel_9`. It matches exactly. An emulator's adb name does not say which Pixel it is [observed: expo/universe#33238].

A client's current device name is only the default: iOS reports the placeholder `iPhone Simulator` until the simulator names itself [observed: `useIosDevice.ts`], and the website saw the name never arrive on staging [observed: expo/universe#32890]. A consumer that knows the model, such as the website from the saved session device, passes `model`.

## Clip path, not mask

A shape is a CSS `clip-path` polygon in percentages of the element: 19 samples of each superellipse corner, each corner sized as its share of the element's short side. A `mask-image` lands a few device pixels off at fractional element sizes, so the website moved from a mask to a clip path [observed: expo/universe#32698].

## Displays and orientation

- A table entry is one shape, or one shape per display with the display a new session starts on. The iPhone Duo is the only per-display entry today. iOS and Android share one lookup, so a foldable on either platform needs only a new entry [observed: `catalog.ts`].
- A multi-display device picks its shape from `display`, the client's `screen.display` by default (LLP 0016 [Display identity](0016-hub-client-foldable-devices.spec.md#display-identity)). When a screen size is known without a display, the display with the closest aspect ratio wins, as the website did [observed: `iphoneDuoStreamScreenShape` in expo/universe#32807]. Without either, the iPhone Duo shows its cover display, which a new session streams first [observed: expo/universe#32807].
- The shape turns with the device: `landscape_left` moves each corner one step clockwise [observed: expo/universe#32682; the same order as `displayCornerRadii` in `display-corners.ts`].
- A landscape frame can only come from a sideways device. When the stream reports no orientation or an upright one for it, the shape counts it as `landscape_left` [observed: `simulatorDeviceRotation` in expo/universe#32682].
- While the client reports no screen, such as while it reconnects or after the session ends, the shape keeps the last display and orientation [observed: `lastStreamScreen` in expo/universe#32890]. The kept screen belongs to the client's current device and model: another device, another model, or no client starts from the defaults.

## Decisions

- **The iPhone Duo cover shape is named `iPhoneDuoCover`**, after hub-client's display role, where the website named it `iPhoneDuoOuter`. Claude Code's choice; human review pending.
- **The entry has device shapes only.** `uniformScreenShape` is internal: it builds the table. A shape that is not a device, such as the squircle of the expo.dev Demos page, stays in its app with its own code, and so does the mask image that draws it [confirmed] (Krystof Woldrich, 2026-11-10).
- **The clip helpers stay public.** The website clips Framer Motion layers and a `<video>`, and blends the iPhone Duo shapes on the recording's video frames, which a wrapping component cannot do. Claude Code's choice; human review pending.
- **`DeviceClient.displayCorners` stays.** It is the DeviceKit chrome corners for the iPhone Duo and is not part of this entry. Claude Code's choice; human review pending.

## Open questions

- Should `displayCorners` go once the dashboard uses shapes for the iPhone Duo?
