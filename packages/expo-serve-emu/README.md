# expo-serve-emu

Expo DevTools plugin that serves the [`serve-emu`](../serve-emu) Android emulator
preview directly from the Expo CLI dev server — the Android counterpart to
[`expo-serve-sim`](../expo-serve-sim).

## How it works

`expo-module.config.json` registers a `devtools` plugin with no `webpageRoot`.
Instead it points `serverEntryPoint` at `server/index.js`, a fetch-style
`handler(request)` that the Expo CLI invokes for every request under
`/_expo/plugins/expo-serve-emu/*`.

serve-emu is a **Bun** program (`Bun.serve`, native WebSockets, `Bun.file`), so
unlike serve-sim it can't be imported into the Node process that runs Expo CLI.
The entry point therefore keeps the vendored serve-emu **completely unchanged**
and acts as a thin bridge:

1. **Lazily spawns** the `serve-emu` CLI as its own Bun process on a free port,
   only when the panel is first opened.
2. **Reverse-proxies HTTP** to that process, streaming responses so the logcat
   SSE feed and binary endpoints (screenshots, APK upload) work through the
   fetch boundary.
3. **Proxies the `/ws` WebSocket** (the H.264 video + gesture channel) through
   the Expo DevTools plugin `webSocketHandlers` export. Expo CLI accepts the
   browser socket, then this bridge opens a client socket to the Bun process and
   forwards frames in both directions.
4. **Rewrites the served `index.html`** so the UI's absolute `/api`, `/ws`, and
   `/health` URLs (and its built asset paths) resolve under the plugin prefix.

Because all the glue lives in this package, pulling upstream serve-emu changes
stays a clean `git am` with no conflicts in the vendored copy.

`cliBanner` is enabled with `bannerTitle: "Emulator"`, so the dev server prints:

```
Emulator: http://localhost:8081/_expo/plugins/expo-serve-emu
```

## Requirements

- [Bun](https://bun.sh) on `PATH` (used to run the serve-emu process).
- A booted Android emulator or attached device (`adb devices`).
- The serve-emu UI must be built once: run `bun run setup` in
  `packages/serve-emu/packages/serve-emu` (fetches scrcpy and builds the UI).

## Usage

Add the package as a dependency of your Expo app; autolinking discovers the
DevTools plugin and the CLI serves it automatically when you run `expo start`.
