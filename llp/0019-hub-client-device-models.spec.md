# LLP 0019: HubClient device models

**Type:** Spec
**Status:** Draft
**Systems:** HubClient, HubComponents, Hub
**Author:** Claude Code (Claude Fable 5.2), directed by Krystof Woldrich
**Date:** 2026-11-17
**Related:** LLP 0000, LLP 0004, LLP 0016, LLP 0017

## Summary

`@expo/hub-client/models` shows a device as its 3D model, with the live screen on its display: the iPhone Duo, the iPhone 18 Pro, the Pixel 9 Pro, and the Pixel 9 Pro Fold. It is an extra, as `@expo/hub-client/shapes` is: an app that does not import it bundles no three.js and no model. The Hub dashboard uses it, and the expo.dev website can.

> **Provenance.** Claude Code wrote this draft while it moved the 3D preview into hub-client. `[observed]` claims give their source. `[confirmed]` claims name a human and a date. File paths are relative to `packages/@expo/hub-client`. The 3D preview itself, its scene, its models, and its hinge handles, is described in LLP 0004 [3D preview in the Hub](0004-serve-sim-hinge-controls.explainer.md#3d-preview-in-the-hub).

## Direction

- The 3D models move from `@expo/hub-components`, which is private, into hub-client, which is published [confirmed] (Krystof Woldrich, 2026-11-17).
- They are an extra, like the device shapes: a library that decides to use them imports them, and they are not part of hub-client's presentation by default [confirmed] (Krystof Woldrich, 2026-11-17).
- The expo.dev website is the first consumer after the Hub [confirmed] (Krystof Woldrich, 2026-11-17).

## Public surface

| Entry                                | Exports                                                                                                                                                                             | Loads three.js |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `@expo/hub-client/models`            | `DeviceModelScreen`, and everything in the catalog                                                                                                                                  | yes            |
| `@expo/hub-client/models/catalog`    | `resolveDeviceModel`, `deviceModelFor`, `DEVICE_MODELS`, `DEVICE_MODEL_IDS`, `isDeviceModelId`, `deviceModelStreamable`, `deviceModelPreview`, `modelStageMaxSide`, and their types | no             |
| `@expo/hub-client/models/<file>.glb` | One GLB file per model: `iphone-duo`, `iphone-18-pro`, `pixel-9-pro`, `pixel-9-pro-fold`                                                                                            | no             |

`DeviceModelScreen` takes the place of `DeviceScreen`. It takes the device client, a model description from the catalog, and the URL of the model's GLB file. It reports a model that cannot load with `onUnavailable`, and the consumer then shows the flat screen [observed: `src/models/DeviceModelScreen.tsx`].

## Two entries

- The main entry never imports `models/`, and the package keeps `sideEffects: false`. A test bundles every export of the main entry and checks that the output has no three.js, no model table, and no module of `models/` or `shapes/` [observed: `src/__tests__/device-model-entries.test.ts`].
- The catalog is its own entry and does not import three.js. A dashboard asks it whether a device has a model, whether the client can feed it, and how large the stage is, before it loads the scene. `PhoneFrame` in hub-components reads only the catalog, and the consumer passes `DeviceModelScreen` in as a prop [observed: `src/models/catalog.ts`, `hub-components/src/dashboard/PhoneFrame.tsx`]. A test bundles the catalog and checks that the output has the model table and no three.js.
- A separate entry keeps this true without a bundler that removes unused exports [inferred]. The Hub's `expo export` output is one JS file with every module [observed: `dist/client/_expo/static/js/web` after `bun run build:web`].
- The test fixtures use what they import. A fixture of re-exports alone makes Bun write a bundle with no code, so a check of that bundle passes whatever the entry imports. The shape test of LLP 0017 had such a fixture [observed: a 75-byte bundle before this change; `src/__tests__/fixtures/main-entry-only.ts`].

## Dependencies

`three` and `three-mesh-bvh` are optional peer dependencies of hub-client, with the versions that the scene is tested with [observed: `package.json`]. A consumer of the models entry installs them. A consumer of the other entries does not.

Both are peers, because `three-mesh-bvh` declares `three` as its own peer [observed: `three-mesh-bvh@0.9.18`'s `package.json`]. As a plain dependency it would ask every consumer of hub-client for `three`.

## Model files

- The four GLB files are in `models/` at the package root, and the `exports` pattern `./models/*.glb` serves them, so a file's import path and its path in the package are the same [observed: `package.json`]. The export's `types` condition types each import as the file's URL, a string, so a TypeScript consumer needs no `*.glb` module declaration of its own [observed: `models/glb.d.ts`]. `models/README.md` records their source commit, sizes, and hashes.
- A consumer imports the files of the models it shows. Its bundler emits them and gives their URLs, which the consumer passes to `DeviceModelScreen`. A model loads only when the screen mounts.
- The Hub imports them as Metro assets. `expo export` copies them to `dist/client/assets/_@expo/hub-client/models/`, and the standalone CLI serves them from there [observed: `expo export` output, `expo-device-hub/metro.config.js`]. For an asset outside the app's package, `expo export` writes the URL as `.//assets/…`; the dashboard removes the empty path segment [observed: `modelAssetUrl` in `expo-device-hub/src/Dashboard.tsx`].
- The files add 14.8 MB to the package, and nothing to a bundle that does not import them.
- A description names nodes and materials of its GLB file, and the bend code is a port for these exact files (LLP 0004 [Device models](0004-serve-sim-hinge-controls.explainer.md#device-models)). So a file and its description are in one package and change in one commit.

## Model names

`resolveDeviceModel({ platform, model })` takes the hardware model names that `resolveScreenShape` takes (LLP 0017 [Model names](0017-hub-client-screen-shapes.spec.md#model-names)): the simulator device type name on iOS, without case and surrounding spaces, and the AVD hardware profile id on Android, exactly. A consumer that knows a device's model for its shape, as the website does, uses the same name for its 3D model. A test checks that every 3D model has a name, and that each name also has a screen shape [observed: `src/__tests__/device-model-entries.test.ts`].

The Hub does not use the names yet. Its server sends `Device.deviceModel`, a model id, next to `Device.model`: a physical Android device gets its 3D model from its product model, and it has no `model` [observed: `androidDevice3DModel` in `expo-device-hub/src/server/device-support.ts`, `androidDeviceModel` in `expo-device-hub/src/server/device-models.ts`].

## Decisions

- **The GLB files are in hub-client**, not in a package of their own. One version then covers a description and its file. The cost is the package size. Claude Code's choice; human review pending.
- **`canvasFrameNumber` and `markCanvasFrame` are internal.** #559 exported them from the main entry for the 3D scene in hub-components. The scene is in hub-client now, and no release had them. Claude Code's choice; human review pending.
- **The files keep their names.** The move does not rename the `duo-*` modules, so the diff shows only the import changes. Claude Code's choice; human review pending.
- **The "3D preview unavailable" notice reads the Expo theme variables** with the browser's system colors as fallbacks, as `TouchIndicator` reads `--expo-theme-border-info` [observed: `src/TouchIndicator.tsx`, `src/models/DuoModelView.tsx`]. hub-client has no design tokens of its own. Claude Code's choice; human review pending.
- **The peer range of `three` is `^0.186.0`**, one minor version, because three.js changes its API between minor versions. Claude Code's choice; human review pending.

## Open questions

- Should the Hub look the model up by name and stop sending `deviceModel`? A physical Android device would then need a `model`, which also gives it a screen shape.
- Should the catalog entries be opaque? A description's GLB node names are public types now.
