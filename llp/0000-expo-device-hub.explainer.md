# LLP 0000: Expo Device Hub

**Type:** Explainer
**Status:** Active
**Systems:** Hub, HubClient, HubComponents, AppleUtils, AndroidUtils, ServeSim, ServeEmu, Example, Release, LLP
**Role:** Root
**Author:** Claude Code (Claude Opus 5.5), directed by Krystof Woldrich
**Date:** 2026-10-02
**Revised:** 2026-10-03 (reviewed and made Active by Krystof Woldrich)

## Summary

Expo Device Hub lets a developer see and control iOS simulators and Android emulators in the browser. It runs as an Expo DevTools plugin inside `expo start`, or as a standalone server (`npx expo-device-hub`) [observed: `README.md`].

This monorepo contains the Hub, the browser libraries that connect to devices, and the two device servers: `serve-sim` for iOS and `serve-emu` for Android [observed: root `package.json` workspaces].

Read this document first. It tells you which package owns what, how the packages connect, and which constraints you must not simplify away. Each section names where to look next.

> **Provenance.** An agent wrote this draft from the code, the package `AGENTS.md` files, and the git history. `[observed]` claims give their source. `[confirmed]` claims name a human and a date. `[inferred]` claims are guesses that a maintainer must confirm or delete. No `[inferred]` claims remain. Krystof Woldrich reviewed this document and made it `Active` on 2026-10-03.

## Packages

| Package | `Systems` name | What it owns | Published |
|---|---|---|---|
| `packages/expo-device-hub` | `Hub` | The DevTools plugin: the dashboard UI and the device server that mounts serve-sim and serve-emu. | `expo-device-hub` |
| `packages/@expo/hub-client` | `HubClient` | Browser hooks and components (`DeviceScreen`, `useActiveDeviceClient`, …) that connect to serve-sim or serve-emu and paint the stream. | `@expo/hub-client` |
| `packages/@expo/hub-components` | `HubComponents` | Dependency-free UI kit and design tokens ported from `@expo/styleguide`. | private |
| `packages/@expo/hub-apple-utils` | `AppleUtils` | Lists, creates, and boots simulators through `simctl`. | private |
| `packages/@expo/hub-android-utils` | `AndroidUtils` | Lists, creates, and boots emulators through `avdmanager`, `sdkmanager`, `emulator`. | private |
| `packages/serve-sim/packages/serve-sim` | `ServeSim` | iOS simulator server: Swift capture addon, HTTP and WebRTC streams, input, preview UI, CLI. | `@expo/serve-sim` |
| `packages/serve-emu/packages/serve-emu` | `ServeEmu` | Android server: scrcpy, H.264 over WebSocket, WebCodecs UI, REST control API, CLI. | private |
| `example` | `Example` | A minimal Expo app with the plugin installed. | private |

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
7. <a id="sim-test-isolation"></a>**serve-sim tests never touch another session's simulator.** `bun run test` puts an `xcrun` shim on `PATH` that refuses `simctl`. `bun run test:e2e` requires `SERVE_SIM_TEST_UDID` and a private state directory. This is because other agents may keep simulators running on the same machine [observed: `packages/serve-sim/AGENTS.md` "Commands"].
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

| Topic | Source |
|---|---|
| serve-sim video pipeline and recording | [LLP 0001](0001-serve-sim-video-pipeline.explainer.md) |
| serve-sim WebRTC signaling and control | [LLP 0002](0002-serve-sim-webrtc-architecture.explainer.md) |
| serve-sim HTTP routes, auth, CORS, WebSockets | [LLP 0003](0003-serve-sim-http-api.spec.md) |
| serve-sim hinge controls and display selection | [LLP 0004](0004-serve-sim-hinge-controls.explainer.md) |
| serve-sim network capture and redaction | [LLP 0005](0005-serve-sim-network-capture.explainer.md) |
| How Simulator.app forwards scroll (reverse-engineered) | [LLP 0006](0006-serve-sim-scroll-injection.research.md) |
| serve-sim capability loader | [LLP 0007](0007-serve-sim-capability-loader.explainer.md) |
| serve-emu scrcpy framing, control packets, `SEMU` metadata | [LLP 0008](0008-serve-emu-protocol.spec.md) |
| serve-emu hardware H.264 encoder spike | [LLP 0009](0009-serve-emu-hardware-encoder-spike.research.md) |
| Hub UI rules and tokens | `packages/expo-device-hub/AGENTS.md` |
| serve-sim commands, tests, definition of done | `packages/serve-sim/AGENTS.md`, `packages/serve-sim/REVIEW.md` |
| serve-emu layout and auth | `packages/serve-emu/AGENTS.md` |
| Releases | `RELEASING.md` |

LLPs 0001–0009 were moved here from the package `docs/` folders and from `Sources/ServeSimCapabilityLoader/DESIGN.md`. Agent instructions, READMEs, and process docs stay in their packages.

## Known drift

- The root `README.md` still calls `packages/serve-sim` "Vendored source for `@expo/serve-sim`", but the package is now maintained and published from this repo [observed: #79, #125].
- The root `README.md` lists `packages/expo-serve-emu`, but that directory does not exist. It was merged into `serve-emu` in `599175f5` [observed: `ls packages`, git history].

#244 fixes both. Remove this section when #244 merges.

## Open questions for the maintainer

None at this time.
