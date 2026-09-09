# Contributing to serve-emu

Thanks for taking the time to improve `serve-emu`. This project sits between
Android devices, scrcpy, Bun, WebSockets, and a browser UI, so small protocol or
latency changes can have large user-visible effects. Please keep changes focused
and include enough verification detail for reviewers to reproduce your results.

## Development Setup

Required for the device-free development and CI checks:

- Bun 1.3.13 (the version pinned by the repository)
- Node.js 18+

Optional prerequisites for manual runtime validation:

- Android platform-tools with `adb` on `PATH`
- A booted Android emulator or attached Android device
- Chrome, Edge, or Safari 16.4+ for WebCodecs support

Install dependencies:

```sh
bun install --frozen-lockfile
```

Fetch the vendored scrcpy server and build the browser UI:

```sh
bun run --filter serve-emu setup
```

Run the local server:

```sh
bun run packages/serve-emu/src/cli.ts
```

Then open `http://localhost:3300`.

Useful alternatives:

```sh
bun run dev
bun run --filter serve-emu dev:ui
bun run --filter serve-emu start
```

## Project Layout

- `packages/serve-emu/src/cli.ts` - CLI entry point
- `packages/serve-emu/src/server.ts` - HTTP, WebSocket, and API server
- `packages/serve-emu/src/scrcpy.ts` - scrcpy server lifecycle and video stream handling
- `packages/serve-emu/src/input.ts` - scrcpy control socket message encoding
- `packages/serve-emu/src/emulator.ts` - Android Emulator discovery and launch helpers
- `packages/serve-emu/src/ui/` - React browser UI
- `packages/serve-emu/scripts/fetch-scrcpy.ts` - pinned scrcpy server downloader

Prefer kebab-case for TypeScript and JavaScript filenames.

## Validation

Before opening a pull request, run the checks that match your change:

```sh
bun run --filter serve-emu test
bun run --filter serve-emu coverage
bun run --filter serve-emu typecheck
bun run --filter serve-emu typecheck:ui
bun run --filter serve-emu typecheck:tests
bun run --filter serve-emu build
```

Run the same aggregate check used by CI before requesting review:

```sh
bun run check
```

The aggregate check verifies generated documentation, runs package coverage,
checks the server, browser, and test TypeScript projects, builds the production
UI, and exercises the packed package. The default CI suite is entirely
device-free: fake clocks, timers, sockets, processes, and sessions exercise
lifecycle and protocol behavior without an Android SDK, ADB, an emulator, or a
connected device.

For runtime changes, optionally supplement CI with a real device or emulator:

```sh
adb devices
bun run packages/serve-emu/src/cli.ts
```

Verify the relevant user flow in the browser, such as:

- live video starts and recovers after refresh
- taps, swipes, text input, and hardware buttons work
- multiple browser tabs can share one stream
- `/api/screenshot`, `/api/tap`, `/api/text`, and other changed APIs behave as expected
- app management, logcat, location, route playback, or session replay still work if touched

If there is no automated test for your change, mention the manual verification
you performed in the pull request.

## scrcpy and ADB Notes

Streaming uses the vendored scrcpy server at
`packages/serve-emu/vendor/scrcpy-server-v<VERSION>`.
The pinned version is controlled by `packages/serve-emu/scripts/fetch-scrcpy.ts`.

The scrcpy wire protocol can drift between major versions. If you bump the
scrcpy server version, follow the complete
[scrcpy upgrade checklist](packages/serve-emu/docs/protocol.md#scrcpy-upgrade-checklist).
The canonical protocol reference documents the current v3/v4 video framing,
control messages, `SEMU` WebSocket metadata, and byte-level golden examples. Do
not duplicate those layouts in another document; update the reference and its
parser fixtures together.

Do not shell out to `adb shell input` for device interaction. Write to scrcpy's
control socket instead; the latency difference is large enough to affect agent
workflows.

If more than one device is connected, require or pass `-s <serial>`. The default
target should be the only booted device.

## Pull Request Guidelines

Please keep pull requests small and focused. A good PR includes:

- a short description of the user-visible behavior change
- screenshots, recordings, or API examples when UI or runtime behavior changes
- the commands you ran for validation
- any device/emulator model and Android version used for manual testing
- notes about protocol, latency, or compatibility risks

Avoid unrelated formatting, generated file churn, and broad refactors unless they
are needed for the change.

## Commit Guidelines

Use atomic commits. Commit only files you changed, and list each file path
explicitly in the commit command.

For tracked files:

```sh
git commit -m "<scoped message>" -- path/to/file1 path/to/file2
```

For brand-new files, clear staged state first, then stage only the files you
created:

```sh
git restore --staged :/
git add "path/to/file1" "path/to/file2"
git commit -m "<scoped message>" -- path/to/file1 path/to/file2
```

## Release Guidelines

`serve-emu` uses the package version in `packages/serve-emu/package.json` as the
source of truth. Release tags should be named `v<version>`, for example
`v0.1.0`.

The npm package exposes its CLI plus the `serve-emu`, `serve-emu/middleware`,
`serve-emu/stream-socket`, and `serve-emu/stream-settings` programmatic entry
points. New entry points must be added explicitly to `exports`, documented as a
supported API, exercised from the packed tarball in a temporary consumer, and
reviewed for semver impact. Publishing source files does not make unlisted deep
imports public APIs.

Choose the version bump with semver:

- `patch` for fixes and small internal improvements
- `minor` for backwards-compatible user-facing features or APIs
- `major` for breaking CLI, HTTP API, WebSocket protocol, package, or runtime behavior

Prepare a release:

```sh
bun run release -- patch
```

You can also pass `minor`, `major`, or an exact version such as `0.1.0`.

Before publishing, review `packages/serve-emu/CHANGELOG.md`, then run:

```sh
bun run check
```

That verifies generated documentation, runs package coverage, checks the server,
UI, and test TypeScript projects, builds the production UI, and runs the
packed-tarball consumer smoke test.

Commit only the version and changelog files, then tag and publish:

```sh
git commit -m "Release v<version>" -- packages/serve-emu/package.json packages/serve-emu/CHANGELOG.md
git tag v<version>
npm publish packages/serve-emu
git push origin HEAD --tags
```

## Reporting Issues

When reporting a bug, include:

- `serve-emu` version or commit SHA
- Bun and Node.js versions
- host OS
- device or emulator type and Android version
- `adb devices` output with serials redacted if needed
- exact command used to start `serve-emu`
- browser and version
- logs, screenshots, or a short recording if available

For streaming problems, note whether the issue affects first load, refresh,
multiple tabs, keyframe recovery, input latency, or all video output.
