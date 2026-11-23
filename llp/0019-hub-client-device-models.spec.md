# LLP 0019: HubClient device models

**Type:** Spec
**Status:** Draft
**Systems:** HubClient, HubComponents, Hub
**Author:** Claude Code (Claude Fable 5.2), directed by Krystof Woldrich
**Date:** 2026-11-17
**Revised:** 2026-11-18 (the 3D screen takes a limited client; a check of the packed files; the peer range of three; Claude Code, directed by Krystof Woldrich)
**Related:** LLP 0000, LLP 0004, LLP 0016, LLP 0017

## Summary

`@expo/hub-client/models` shows a device as its 3D model, with the live screen on its display: the iPhone Duo, the iPhone 18 Pro, the Pixel 9 Pro, and the Pixel 9 Pro Fold. It is an extra, as `@expo/hub-client/shapes` is: an app that does not import it bundles no three.js and no model. The Hub dashboard uses it, and the expo.dev website can.

> **Provenance.** Claude Code wrote this draft while it moved the 3D preview into hub-client. `[observed]` claims give their source. `[confirmed]` claims name a human and a date. File paths are relative to `packages/@expo/hub-client`. The 3D preview itself, its scene, its models, and its hinge handles, is described in LLP 0004 [3D preview in the Hub](0004-serve-sim-hinge-controls.explainer.md#3d-preview-in-the-hub).

## Direction

- The 3D models move from `@expo/hub-components`, which is private, into hub-client, which is published [confirmed] (Krystof Woldrich, 2026-11-17).
- They are an extra, like the device shapes: a library that decides to use them imports them, and they are not part of hub-client's presentation by default [confirmed] (Krystof Woldrich, 2026-11-17).
- The expo.dev website is the first consumer after the Hub [confirmed] (Krystof Woldrich, 2026-11-17).

## Public surface

| Entry                                | Exports                                                                                                                                                                                                           | Loads three.js |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `@expo/hub-client/models`            | `DeviceModelScreen`, and everything in the catalog                                                                                                                                                                | yes            |
| `@expo/hub-client/models/catalog`    | `resolveDeviceModel`, `deviceModelFor`, `DEVICE_MODELS`, `DEVICE_MODEL_IDS`, `isDeviceModelId`, `deviceModelStreamable`, `deviceModelPreview`, `modelStageMaxSide`, `useDeviceModelScreenClient`, and their types | no             |
| `@expo/hub-client/models/<file>.glb` | One GLB file per model: `iphone-duo`, `iphone-18-pro`, `pixel-9-pro`, `pixel-9-pro-fold`, each typed as its URL                                                                                                   | no             |

`DeviceModelScreen` takes the place of `DeviceScreen`. A consumer must not put it under `visibility: hidden`: the browser then presents no frames of the hidden stream elements, so `framePresented` stays false and the model never shows [observed: the expo.dev website, expo/universe#33612, which hides its stage with `opacity: 0` for that reason]. It takes the device client, a model description from the catalog, and the URL of the model's GLB file. It reports a model that cannot load with `onUnavailable`, and the consumer then shows the flat screen [observed: `src/models/DeviceModelScreen.tsx`].

## Screen client

`DeviceModelScreen` takes a `DeviceModelScreenClient`: the `DeviceScreenClient` of the flat `DeviceScreen`, plus `displays` and `orientation` [observed: `src/models/model-screen-client.ts`]. `useDeviceModelScreenClient()` selects that part from the provider's client and compares it property by property, so a component that uses it does not render again for metrics, FPS, or logs. It is in the catalog entry, because it does not need three.js and a consumer calls it before it loads the scene.

- The type exists so that the 3D screen cannot read an unrelated property by accident, as the flat screen cannot [confirmed] (Krystof Woldrich, 2026-11-18). Before it, the screen took a full `DeviceClient`. With `useDeviceClient()` that still rendered only for the properties that were read, because that hook records the reads, but no type and no test kept the reads to that set [observed: `createTrackedClient` in `src/useDeviceClient.ts`].
- A test renders the screen for a foldable and for a phone with a client that records its reads, and checks that every read is a property of the type [observed: `src/__tests__/device-model-screen-client.test.tsx`].
- A full `DeviceClient` still fits, so the Hub dashboard passes its client as before [observed: `hub-components/src/dashboard/PhoneFrame.tsx`].

## Two entries

- The main entry never imports `models/`, and the package keeps `sideEffects: false`.
- The catalog is its own entry and does not import three.js. A dashboard asks it whether a device has a model, whether the client can feed it, and how large the stage is, before it loads the scene. `PhoneFrame` in hub-components reads only the catalog, and the consumer passes `DeviceModelScreen` in as a prop [observed: `src/models/catalog.ts`, `hub-components/src/dashboard/PhoneFrame.tsx`].
- A separate entry keeps this true without a bundler that removes unused exports [inferred]. The Hub's `expo export` output is one JS file with every module [observed: `dist/client/_expo/static/js/web` after `bun run build:web`].
- A test walks the modules that each entry loads at run time, before any bundler removes code, and the packages that those modules import. The main entry and the shapes entry reach no three.js and no module of `models/`, the catalog reaches no three.js, and the same walk finds three.js from the models entry [observed: `runtimeGraph` in `src/__tests__/device-model-entries.test.ts`]. A check of bundled output alone can pass while an entry imports three.js: a bundler drops an export that the test app does not use [observed: a Codex review of this change re-exported `Vector3` from the main entry and `DeviceModelScreen` from the catalog, and the first version of the tests stayed green].
- The bundle tests use what they import. A fixture of re-exports alone makes Bun write a bundle with no code, so a check of that bundle passes whatever the entry imports. The shape test of LLP 0017 had such a fixture [observed: a 75-byte bundle before this change; `src/__tests__/fixtures/main-entry-only.ts`].

## Dependencies

`three` and `three-mesh-bvh` are optional peer dependencies of hub-client [observed: `package.json`]. A consumer of the models entry installs them. A consumer of the other entries does not.

- Both are peers, because `three-mesh-bvh` declares `three` as its own peer [observed: `three-mesh-bvh@0.9.18`'s `package.json`]. As a plain dependency it would ask every consumer of hub-client for `three`.
- The range of `three` is `>=0.186.0`, the version that the scene is tested with [confirmed] (Krystof Woldrich, 2026-11-18). three.js changes its API between minor versions. With the range `*`, an app with an older `three` installs with no signal, and its developer finds the problem only at run time [observed: a review of this change by hirbod, expo/expo-device-hub#638].
- The cost of that range is known. An optional peer still limits the version of a package that is installed: npm refuses hub-client in an app that has an older `three` for its own use, also when the app does not import the models entry [observed: `npm install --dry-run` with npm 11.13.0 and a probe package, 2026-11-18, `ERESOLVE` on `peerOptional three@">=0.186.0"` with `three@0.160.0`; and in a Codex review of this change, `ERESOLVE` on `peerOptional three@"^0.186.0"` with `three@0.185.0`]. pnpm, Yarn, and Bun were not tested.
- The range has no upper limit, so a newer `three` installs. The first range, `^0.186.0`, accepts only 0.186.
- The range of `three-mesh-bvh` is `*`. That package declares `three >= 0.159.0` as its own peer [observed: `three-mesh-bvh@0.9.18`'s `package.json`].
- The scene is tested with the versions in `devDependencies`, `three` 0.186 and `three-mesh-bvh` 0.9.18, and the README names them. A test checks that the version in `devDependencies` is in the peer range [observed: `src/__tests__/device-model-entries.test.ts`].

## Model files

- The four GLB files are in `models/` at the package root, and each has its own entry in `exports`, so a file's import path and its path in the package are the same, and a misspelled file name fails in TypeScript and in the bundler [observed: `package.json`]. Each export's `types` condition types the import as the file's URL, a string, so a TypeScript consumer needs no `*.glb` module declaration of its own [observed: `models/glb.d.ts`]. `models/README.md` records their source commit, sizes, and hashes.
- A consumer imports the files of the models it shows. Its bundler emits them and gives their URLs, which the consumer passes to `DeviceModelScreen`. A model loads only when the screen mounts. A bundler without a rule for `.glb` files takes the URL with `new URL("@expo/hub-client/models/<file>.glb", import.meta.url)` [observed: a Turbopack build in a Codex review of this change].
- The Hub imports them as Metro assets. `expo export` copies them to `dist/client/assets/_@expo/hub-client/models/`, and the standalone CLI serves them from there [observed: `expo export` output, `expo-device-hub/metro.config.js`]. For an asset outside the app's package, `expo export` writes the URL as `.//assets/…`; the dashboard removes the empty path segment [observed: `modelAssetUrl` in `expo-device-hub/src/Dashboard.tsx`].
- The files add 14.8 MB to the package, and nothing to a bundle that does not import them.
- A check packs the package as `npm publish` does, without writing it, and compares the file list with the manifest: every entry point's file is packed, every `files` entry matches a file, and no test file is packed. The tests read `package.json` and the source tree, so a `files` entry that matches nothing passed them [observed: a review of this change by hirbod, expo/expo-device-hub#638; `src/__tests__/packed-files.ts`, `bun run test:package`, the `Hub client package content` step of `.eas/workflows/checks.yml`]. The check runs after the build, because the entry points name build output.
- A page with a Content Security Policy needs `blob:` in `connect-src`, because three.js fetches the textures inside a GLB file from blob URLs that it makes, and `'wasm-unsafe-eval'` in `script-src`, because the files are compressed with Meshopt and three.js decodes them with WebAssembly [observed: the expo.dev website's policy blocked both until it allowed them, `server/website/server/security.js` in expo/universe; `MeshoptDecoder` in `src/models/device-model-rig.ts`]. The README names both.
- A description names nodes and materials of its GLB file, and the bend code is a port for these exact files (LLP 0004 [Device models](0004-serve-sim-hinge-controls.explainer.md#device-models)). So a file and its description are in one package and change in one commit.

## Model names

`resolveDeviceModel({ platform, model })` takes the hardware model names that `resolveScreenShape` takes (LLP 0017 [Model names](0017-hub-client-screen-shapes.spec.md#model-names)): the simulator device type name on iOS, without case and surrounding spaces, and the AVD hardware profile id on Android, exactly. A consumer that knows a device's model for its shape, as the website does, uses the same name for its 3D model. A test checks that every 3D model has a name, and that each name also has a screen shape [observed: `src/__tests__/device-model-entries.test.ts`].

The Hub does not use the names yet. Its server sends `Device.deviceModel`, a model id, next to `Device.model`: a physical Android device gets its 3D model from its product model, and it has no `model` [observed: `androidDevice3DModel` in `expo-device-hub/src/server/device-support.ts`, `androidDeviceModel` in `expo-device-hub/src/server/device-models.ts`].

## Decisions

- **The GLB files are in hub-client**, not in a package of their own. One version then covers a description and its file. The cost is the package size. Claude Code's choice; human review pending.
- **`canvasFrameNumber` and `markCanvasFrame` are internal.** #559 exported them from the main entry for the 3D scene in hub-components. The scene is in hub-client now, and no release had them. Claude Code's choice; human review pending.
- **The files keep their names.** The move does not rename the `duo-*` modules, so the diff shows only the import changes. Claude Code's choice; human review pending.
- **The "3D preview unavailable" notice reads the Expo theme variables** with the browser's system colors as fallbacks, as `TouchIndicator` reads `--expo-theme-border-info` [observed: `src/TouchIndicator.tsx`, `src/models/DuoModelView.tsx`]. hub-client has no design tokens of its own. Claude Code's choice; human review pending.
- **The peer range of `three` is `>=0.186.0`** (see [Dependencies](#dependencies)). The first version had `^0.186.0`, one minor version. A Codex review showed that it breaks installs, and the range became `*`. hirbod's review showed that `*` gives no signal for an old three.js, and Krystof Woldrich chose `>=0.186.0` with the known cost, on 2026-11-18.
- **The peer range of `three-mesh-bvh` is `*`.** The reviews did not ask for a limit. Claude Code's choice; human review pending.
- **`deviceModelStreamable` asks for the iPhone Duo's two displays by id.** #559 checked only that the client has a display list. hub-client's iOS adapter always lists both, and a custom client can now be the caller. Claude Code's choice; human review pending.

## Open questions

- Should the Hub look the model up by name and stop sending `deviceModel`? A physical Android device would then need a `model`, which also gives it a screen shape.
- Should the catalog entries be opaque? A description's GLB node names are public types now.
- hub-client's declaration files import their neighbours without a file extension. TypeScript's `node16` resolution rejects that when `skipLibCheck` is off, for every entry: the main entry, `shapes`, and both `models` entries [observed: `tsc` with `moduleResolution: node16` on a packed build, 24 errors in `dist/index.d.ts`, 4 in `dist/shapes/index.d.ts`, 2 in each `models` entry]. This change does not fix it.
