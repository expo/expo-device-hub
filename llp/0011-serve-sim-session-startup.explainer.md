# LLP 0011: serve-sim session startup

**Type:** Explainer
**Status:** Draft
**Systems:** ServeSim
**Author:** Gabe Debes
**Date:** 2026-10-06
**Related:** [LLP 0007](0007-serve-sim-capability-loader.explainer.md), [LLP 0005](0005-serve-sim-network-capture.explainer.md)

## Scope

The foreground CLI can boot a simulator, install a local `.app`, launch an installed
app with arguments, and open a deep link before starting the preview server. The caller
downloads the app and supplies its path; serve-sim owns the simulator operations
[observed: `src/index.ts` CLI action and `src/launch-app.ts`]. Paths in this document
are relative to `packages/serve-sim/packages/serve-sim`.

## Validate before touching a device

`--install-app-path` requires an existing `.app` directory. The CLI reads
`CFBundleIdentifier` from `Info.plist` with `plutil`, supporting XML and binary
plists, and requires a non-empty string before resolving or booting a device
[observed: `src/index.ts` install-flag validation].

Installation and launch are independent: a caller can install one app and launch
another, or install without requesting a launch. The installed app's identifier
does not need to match `--launch-app-identifier`
[confirmed: Gabe Debes, 2026-10-07; observed: `src/index.ts` startup app operations].

Without `--install-app-path`, the startup launch uses an app already installed.
`--launch-arg` and `--open-url` require a launch identifier. Startup installation,
launch and capability flags are rejected with `--detach`, because the detached
helper only streams and cannot own the foreground session's capability teardown
[observed: `src/index.ts` flag validation; LLP 0007, Lifecycle].

## Boot is a readiness barrier

The simulator's `Booted` state does not mean its services have finished starting.
`ensureBooted` requests boot when needed, then always awaits `simctl bootstatus -b`
with the shared 120-second `BOOT_TIMEOUT_MS`. A failed wait stops startup, even
without an app launch flag; continuing could attempt installation or advertise a
server against a device that is not ready [observed: `src/index.ts` `ensureBooted`;
`src/device.ts` `BOOT_TIMEOUT_MS`].

## Startup order

The foreground CLI finishes these operations before entering preview serving or
foreground streaming [observed: `src/index.ts` CLI action]:

1. Resolve targets and register capability teardown handlers.
2. Await boot completion for every target and clean up stale loader state.
3. Arm the session's capability loader, except in re-executed stream helpers.
4. Attempt requested network capture startup.
5. For each target device, except in stream helpers: install the supplied `.app`
   if present. With a launch identifier, apply launch capabilities, restart the
   specified app with its arguments, then open the optional URL. Without a launch
   identifier, apply requested/default capabilities instead.
6. Enter the selected run mode. Preview startup binds the HTTP server and prints
   its ready output only after the requested app operations have succeeded.

The loader must be inserted before an app starts: dyld reads the insert at `exec`
and cannot add it to an already-running process. See [LLP 0007, The
problem](0007-serve-sim-capability-loader.explainer.md#the-problem). Capture is
attempted before the launch so supported startup requests can use it. Loader
arming and capture startup have best-effort paths that log failures; readiness
does not prove that capture is active [observed: `src/launch-manager.ts`
`armCapabilityLoader`; `src/index.ts` `startNetworkCapture`].

Capability preparation failures during an app launch can also log a diagnostic
and continue: `launchAppAsync` does not check the returned list of applied
capabilities. Without a launch identifier, a missing explicitly requested
capability stops startup. Readiness therefore does not guarantee that every
requested capability was enabled [observed: `src/launch-manager.ts`
`applyDefaultCapabilities`; `src/launch-app.ts`; `src/index.ts` `missingCapabilities` check].

Installation uses the same invocation builder as the authenticated `app.install`
action. `launchAppAsync` awaits launch before opening the URL. These are successful
simctl operations, not proof that the app rendered its UI or handled the deep link
[observed: `src/host-actions-utils.ts` `installAppInvocation`; `src/launch-app.ts`].

## Failure and teardown

Failed boot, install, launch or `simctl openurl` stops startup with exit code 1,
without publishing preview readiness. Under `--quiet`, those failures and
install-flag validation failures emit a JSON `{ "error": "…" }` line on stdout;
normal mode uses stderr.
Other flag-validation and capability diagnostics may still use stderr
[observed: `src/index.ts` `printStartupError` and its callers].

The foreground session attempts capture teardown on signals or startup failure,
and signal/exit handlers release its capability ownership. It releases only the
devices it armed; another live session's insert remains owned by that session.
Stopping the host does not uninstall the app or shut down the simulator
[observed: `src/index.ts` startup
signal handlers and `disarmDevicesArmedHere`; `src/launch-manager.ts` `releaseSession`].
