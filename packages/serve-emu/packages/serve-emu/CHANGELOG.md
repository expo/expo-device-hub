# Changelog

All notable changes to `serve-emu` are documented here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

- `patch` for fixes and small internal improvements
- `minor` for backwards-compatible user-facing features or APIs
- `major` for breaking CLI, HTTP API, WebSocket protocol, package, or runtime behavior

## Unreleased

- Add strict host hardware H.264 encoding for Android gRPC streaming with `--encoder hardware` and an Encoder control in the standalone UI. Software remains the default; stream-mode and health APIs report the active backend and hardware probe failures.

### Fixed

- Synchronize emulator rotation controls with the simulated orientation used by
  gRPC PNG and MMAP screenshots, and align gRPC touch input with rotated frames.

### Added

- Add emulator-only gRPC screenshot streaming with host-side H.264 encoding,
  a CLI source flag, a runtime HTTP API, and a browser UI source selector.
- Add strict PNG and shared-memory MMAP image modes for gRPC capture, selectable
  through configuration, the CLI, runtime API, and browser UI.
- Add selectable scrcpy and emulator gRPC input transports for gRPC screenshot
  streams through configuration, the CLI, runtime API, and browser UI.
- Add `/api/reduce-motion`, `/api/high-text-contrast`, `/api/font-weight` and
  `/api/display-density`, four framework-level Android accessibility settings
  alongside `/api/network` and `/api/font-scale`. Each reads back the key its
  own framework API parses, and display density reports the resulting
  smallest-width dp.

### Changed

- Retain `serve-emu` as the package, CLI, workspace, and user-facing identity
  while integrating upstream runtime and tooling improvements.
- Restore the documented root, middleware, stream-socket, and stream-settings
  package exports for the Expo integration.
- Default gRPC screenshot streams to a control-only scrcpy process (video and
  audio disabled) because its input protocol supports the established control
  semantics; emulator gRPC input remains available when avoiding that extra
  process is preferable.

## 0.0.5 - 2026-07-12

### Breaking

- Define `serve-emu` as a CLI-only package with an empty export map. Root and
  deep JavaScript/TypeScript imports are now blocked; the installed
  `serve-emu` executable and documented runtime HTTP/WebSocket APIs remain the
  supported surfaces.

### Changed

- Remove confirmed internal dead helpers, fields, exports, and unreachable UI
  branches now that repository implementation files are no longer accidental
  package APIs. Session snapshots no longer include the always-true
  `recording` field.
- Add packed-tarball consumer tests and Knip static analysis to the package
  validation pipeline.
- Publish the cumulative package-boundary and runtime improvements as 0.0.5.

## 0.0.4 - 2026-06-21

### Added

- Release helper for patch, minor, major, and exact-version bumps.
- Release validation script that runs tests, server typecheck, UI typecheck, and the production UI build.

### Changed

- Bump the package version from 0.0.3 to 0.0.4.
- Document the release process and align README status text with the package version.

## 0.0.3 - 2026-06-21

### Added

- Device orientation, night mode, font scale, and multi-device routing controls.
- Logcat streaming, accessibility inspection, app management, route playback, and session replay workflows.
- H.264 WebSocket streaming with WebCodecs browser decoding and REST/WebSocket input controls.
