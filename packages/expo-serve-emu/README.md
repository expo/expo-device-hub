# expo-serve-emu

Expo DevTools plugin that serves the [`serve-emu`](../serve-emu) Android emulator
preview directly from the Expo CLI dev server — the Android counterpart to
[`serve-sim`](../serve-sim).

## How it works

`expo-module.config.json` registers a `devtools` plugin with no `webpageRoot`.
It points `serverEntryPoint` at `dist/index.mjs` (built from `src/index.ts`), a
fetch-style `handler(request)` that the Expo CLI invokes for every request under
`/_expo/plugins/expo-serve-emu/*`.

serve-emu now ships a **fetch-style middleware** (`serve-emu/middleware`:
`createApp` → `handleRequest(request) => Response` + `attachWebSocket(socket)`),
so this plugin runs serve-emu **in-process** — no spawned Bun child, no HTTP/WS
reverse proxy:

1. **Lazily creates** one scrcpy-backed app (`createApp`) for the booted device
   on first use. `pickDevice()` targets the only attached device; with zero or
   multiple devices it shows a "waiting for an emulator" page (attach a single
   device — multi-device routing is a planned follow-up).
2. **Forwards HTTP** straight to `app.handleRequest(request)`. The logcat SSE
   feed and binary endpoints (screenshots, APK upload) work as-is because the
   middleware hands back fetch `Response` objects.
3. **Hands the `/ws` WebSocket** (the H.264 video + gesture channel) to
   `app.attachWebSocket` via serve-emu's `fromWsSocket` adapter. Expo CLI accepts
   the browser socket and forwards it through the plugin's `webSocketHandlers`
   export; the adapter wraps it directly — no upstream bridge.
4. **Rewrites the served `index.html`** so the UI's absolute `/api`, `/ws`, and
   `/health` URLs (and its built asset paths) resolve under the plugin prefix.

The scrcpy session is tied to the dev-server process lifetime and torn down on
exit.

`cliBanner` is enabled with `bannerTitle: "Emulator"`, so the dev server prints:

```
Emulator: http://localhost:8081/_expo/plugins/expo-serve-emu
```

## Requirements

- A single booted Android emulator or attached device (`adb devices`).
- `adb` on `PATH`.
- serve-emu must be built — its `dist/` (the preview UI and the vendored scrcpy
  server). In the monorepo: run `bun run setup` then `bun run build` in
  `packages/serve-emu/packages/serve-emu`. **No Bun is needed at runtime** — the
  middleware runs inside the Node process that hosts the Expo CLI.

## Build

```
bun run build      # swc src/index.ts -> dist/index.mjs
```

## Usage

Add the package as a dependency of your Expo app; autolinking discovers the
DevTools plugin and the CLI serves it automatically when you run `expo start`.
