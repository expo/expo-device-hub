- Test-driven development where possible.
- Avoid low-opacity for icons.
- Only support maintained Node.js LTS releases (currently Node 20+). Don't add
  workarounds for end-of-life Node versions.

## Native build notes

- Build native changes with `bun run packages/serve-sim/build.ts`. This rebuilds
  the bundled JS, compiled CLI, camera dylib/helper, AX settings helper, and the
  N-API addon at `packages/serve-sim/dist/native/serve-sim-native.node`.
- After changing Swift/ObjC++ native code, restart any running `serve-sim`
  process. The `.node` addon is loaded once per process, so rebuilding alone
  does not update an already-running server.
- When validating local native changes, run the rebuilt local CLI
  (`node packages/serve-sim/dist/serve-sim.js ...` or the compiled binary in
  `packages/serve-sim/dist/`) rather than `npx serve-sim` or a globally
  installed binary.

## Commands

Run these from the repo root. CI runs the same underlying steps: `bun run
lint` and `bun run typecheck` in `.eas/workflows/checks.yml`, and the same
`bun test` command with `SERVE_SIM_E2E_REQUIRED=1` inside a timeout-and-retry
wrapper in `.eas/workflows/sim-test.yml`. CI runs on a fresh worker with one
simulator of its own, so it needs neither the device pin nor the private
state directory that `test:e2e` adds for shared machines. A green local run
predicts a green PR.

- `bun run check` — lint and typecheck. Run before every commit.
- `bun run build` — full build: bundled JS, compiled CLI, native helpers, and
  the N-API addon. Run once before the test commands; several tests drive the
  built artifacts under `packages/serve-sim/dist/`.
- `bun run test` — the isolated run. It uses a private state directory and
  puts an `xcrun` shim first on `PATH` that refuses `simctl`, so no test can
  find another session's server or touch a booted simulator, even on a
  machine where other agents keep simulators running. Simulator-backed
  suites skip deterministically. Pass paths to narrow it:
  `bun run test -- packages/serve-sim/src/__tests__/ports.test.ts`.
- `bun run test:e2e` — the simulator-backed run. It requires
  `SERVE_SIM_TEST_UDID`, the UDID of a simulator you booted for this run, so
  it never drives a device that belongs to another session, and a private
  state directory, so it never kills another session's server. It builds the
  test fixtures, then sets `SERVE_SIM_E2E_REQUIRED=1` so every precondition
  fails instead of skipping. Every suite that picks a device with
  `e2eDevice()` also calls `requireE2E()`; a test enforces the pairing. One
  suite, `ui-settings.e2e`, skips on CI by design because `simctl ui` hangs
  on shared runners; `SERVE_SIM_UI_E2E=1` forces it on. On exit the run
  kills any server it started and removes its state directory. Export
  `SERVE_SIM_STATE_DIR` yourself to point a run at a server you started, and
  it is left alone. Example: `SERVE_SIM_TEST_UDID=<udid> bun run test:e2e --
  packages/serve-sim/src/__tests__/permissions.e2e.test.ts`.
- `bun run build:fixtures` — the simulator test fixtures on their own.
  `test:e2e` runs this for you.
- The Swift `StreamingPolicyTests` are separate. Run `swift test` in
  `packages/serve-sim`.

## E2E testing with agent-browser

If you are codex, run in the in-app Codex browser instead of using agent-browser. Only use agent-browser when developing from TUIs like Claude Code.

The serve-sim web UI streams the iOS Simulator and forwards clicks, so end-to-end
behavior can be driven from a browser with the `agent-browser` CLI:

1. Build: `bun run packages/serve-sim/build.ts`.
2. Boot a simulator and start the server: `node packages/serve-sim/dist/serve-sim.js --port 3399`.
3. Drive the UI: `agent-browser open http://localhost:3399`, then `snapshot`,
   `click @eN`, `upload input[type=file] <path>`, `screenshot <path>`, etc.
4. Tap inside the simulator with `agent-browser mouse move <x> <y> && mouse down && mouse up`
   — the canvas isn't in the AX tree, so use pixel coordinates from a screenshot.

## E2E testing via the serve-sim CLI

For headless flows that don't need the browser, drive the simulator entirely
through `serve-sim` subcommands against a running server:

- `serve-sim tap <x> <y> [-d udid]` — single-shot tap at normalized (0..1)
  screen coords. Prefer this over `serve-sim gesture` for taps: each `gesture`
  call opens its own WebSocket, so two back-to-back `begin`/`end` invocations
  land far enough apart to register as a long-press.
- `serve-sim gesture '<json>' [-d udid]` — for drags or multi-step gestures
  that need explicit `begin`/`move`/`end` events.
- `serve-sim button [home|lock|…] [-d udid]` — hardware button.
- `serve-sim camera …` — inject the dylib, hot-swap source, toggle mirror.
- `serve-sim ui <option> [value] [-d udid]` — simulator-wide UI options
  (appearance, liquid-glass, color-filter, text-size, reduce-motion,
  increase-contrast, show-borders, reduce-transparency, voiceover,
  hardware-keyboard); `ui status
--json` dumps all. Verify sets via `simctl ui <udid> <option>` readback or
  `simctl spawn <udid> defaults read` on com.apple.Accessibility /
  com.apple.mediaaccessibility / com.apple.UIKit.
- `xcrun simctl openurl booted <url>` — deep-link into apps (faster than
  tapping through Expo Go's recent-projects list).

Typical camera e2e flow: rebuild, `camera --stop-webcam`, `simctl terminate`
the app, `camera <bundleId> --file <img> --mirror on` to re-inject, `openurl`
to load the project, `tap 0.5 0.9` for the shutter, then read the saved JPEG
off disk to verify (see the path under "agent-browser" above).
