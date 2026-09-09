# serve-emu Agent Notes

`serve-emu` is a Bun workspace package that streams an Android emulator or device through scrcpy, forwards H.264 over WebSockets, and decodes it in the browser with WebCodecs. Optimize changes for low latency, protocol correctness, and agent-friendly control APIs.

## Project Layout

- This directory is part of the `expo-device-hub` monorepo. Paths below are relative to this directory; run commands from the monorepo root.
- Main package: `packages/serve-emu`.
- CLI entry point: `packages/serve-emu/src/cli.ts`.
- HTTP, WebSocket, health, and REST APIs: `packages/serve-emu/src/server.ts`.
- scrcpy process, adb forward tunnel, socket setup, and frame parsing: `packages/serve-emu/src/scrcpy.ts`.
- scrcpy control socket message encoding for taps, swipes, keys, text, and video reset: `packages/serve-emu/src/input.ts`.
- Android emulator discovery and launch helpers: `packages/serve-emu/src/emulator.ts`.
- ADB helpers: `packages/serve-emu/src/adb.ts`.
- App install/launch/clear/grant/import helpers: `packages/serve-emu/src/app-management.ts`.
- Location and route playback: `packages/serve-emu/src/location.ts` and `packages/serve-emu/src/route-playback.ts`.
- Still-image camera passthrough for the emulator: `packages/serve-emu/src/camera.ts`.
- Session recording/replay: `packages/serve-emu/src/session-recorder.ts`.
- React UI: `packages/serve-emu/src/ui`.
- Vendored scrcpy downloader and pinned version: `packages/serve-emu/scripts/fetch-scrcpy.ts`.

Prefer kebab-case for TypeScript and JavaScript filenames.

## Common Commands

```sh
bun run submodule:init
bun install --frozen-lockfile
bun run --filter serve-emu setup
bun run --filter serve-emu start
bun run --filter serve-emu dev
bun run --filter serve-emu dev:ui
bun run --filter serve-emu test
bun run --filter serve-emu typecheck
bun run --filter serve-emu build
bun run --filter serve-emu docs:check
bun run --filter serve-emu check
```

`setup` downloads the pinned scrcpy server into
`packages/serve-emu/vendor/` and builds the browser UI. The CLI also runs the
scrcpy setup lazily on first start.

## Runtime Assumptions

- Bun is the primary runtime. Keep server-side code compatible with Bun APIs such as `Bun.serve`, `Bun.argv`, and `ServerWebSocket`.
- The package is ESM. Use explicit `.ts` extensions for local TypeScript imports, following the existing style.
- Default device selection should remain the only booted device. If multiple devices are connected, require or pass `-s <serial>`.
- Do not shell out to `adb shell input` for input events. Write directly to scrcpy's control socket via `src/input.ts`; this keeps latency low enough for agent workflows.
- Location control is emulator-only and uses Android Emulator `geo fix`.
- Camera image passthrough is emulator-only. The [Camera Image](README.md#camera-image)
  section is the source of truth for the mechanism and its constraints. In code, wire feeds
  through `startEmulator({ camera: true })`, and keep a valid PNG at every wired feed path.
  `wiredAtLaunch` is derived by reading the running emulator's `hardware-qemu.ini`, never
  tracked in memory. `handleCameraRequest` in `src/camera.ts` is the single camera HTTP
  handler; both the standalone server and the middleware router mount it rather than
  routing camera requests themselves.
- WebCodecs support matters for the bundled UI, so test streaming changes in a browser that supports it.

## scrcpy Protocol Notes

The canonical [protocol reference](packages/serve-emu/docs/protocol.md) is the
source of truth for scrcpy v3/v4 framing, control packets, `SEMU` metadata,
golden bytes, and the scrcpy upgrade checklist. The server version remains
pinned in `packages/serve-emu/scripts/fetch-scrcpy.ts`; update that marker, the
reference, and parser fixtures together whenever it changes.

Keep protocol-sensitive behavior low-latency and join-safe: detect the video
preamble alignment, bound packet and reader sizes, cache SPS/PPS configuration
for key frames, and encode input directly onto the control socket. Do not add a
second byte-layout description here that can drift from the tested reference.

## Server and API Guidance

- Keep HTTP API inputs bounded. Follow existing `MAX_*_BYTES` limits and explicit payload validation patterns.
- Gesture API coordinates are normalized unit values from `0` to `1`; convert to screen pixels only in `dispatch`.
- Preserve session recording behavior. REST and WebSocket actions should record by default unless payloads explicitly set `record: false`.
- For slow WebSocket clients, keep the backpressure strategy: drop until the next keyframe, request video reset with cooldown, and close clients with excessive buffered bytes.
- Maintain `/health` as the best machine-readable snapshot for agents: include status, stream metadata, client metrics, route/session state, and last error details when relevant.
- Prefer structured JSON errors with `ok: false` for API endpoints rather than throwing raw responses.
- Access control lives in `server.ts` (the `fetch` gate) and `cli.ts` (policy). Defaults bind to loopback (`DEFAULT_HOST`); non-loopback binds require a token unless `--unsafe-no-auth`. Every data-bearing request passes the token gate when auth is on (bearer header, `semu_session` HttpOnly cookie, or `?token=`). The sole exception is the origin-checked `OPTIONS /webrtc/stats` CORS preflight, which must run before authentication because browsers cannot attach the bearer token to it; it returns no live state, and the corresponding `GET` remains token-protected. WS upgrades and other non-GET requests also require a matching `Origin`. The browser bootstraps by exchanging a `?token=` URL for the cookie, so the bundled UI needs no per-request token wiring. Never leak the token into `/health`, `/api`, error bodies, or reconnect URLs, and keep new data-bearing endpoints behind the same gate (it runs before routing, so new routes are covered automatically).

## UI Guidance

- The UI lives under `packages/serve-emu/src/ui` and is built by Vite.
- Keep streaming decode logic in `src/ui/lib/use-stream.ts` and H.264 helpers in `src/ui/lib/h264.ts`.
- Device controls should call the local REST/WebSocket APIs instead of duplicating server-side adb or scrcpy logic in the UI.
- When changing the stream protocol, update both the server frame metadata writer and the UI reader together.

## Validation

Run the aggregate check before handing off a change:

```sh
bun run --filter serve-emu check
```

For runtime or protocol changes, also test manually with a booted emulator or device:

```sh
adb devices
bun run --filter serve-emu start
```

Verify relevant flows: first video frame, browser refresh recovery, multiple tabs, tap/swipe/text/key input, `/api/screenshot`, changed REST APIs, logcat SSE, app management, location, route playback, and session replay when touched.
