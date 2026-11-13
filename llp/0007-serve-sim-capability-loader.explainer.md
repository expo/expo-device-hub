# LLP 0007: The capability loader

**Type:** Explainer
**Status:** Active
**Systems:** ServeSim
**Author:** Imported from expo/serve-sim in #79 (original authors are in that repo); later edits by Gabe Debes
**Date:** 2026-09-23
**Revised:** 2026-10-06 (added startup installation to the detached-mode restrictions and linked the startup explainer); 2026-11-10 (internal manager, direct module imports and capability migration order)

> File paths such as `src/…` are relative to `packages/serve-sim/packages/serve-sim`, unless the text gives a path from the repository root.

The capability loader loads capabilities into eligible simulator apps while keeping
system daemons free of framework dependencies.

## Internal capability module

`src/capabilities/` is an internal module inside serve-sim. It adds no workspace,
npm package, import alias or release boundary. Its public entry point is
`src/capabilities/index.ts`, reached by `./capabilities` imports. There is no root
forwarding file. The module has one registry in `runtime/registry.ts`.
Definition and preparation types live beside
the runtime code in `runtime/capability.ts`, without a separate contracts file
[observed: those modules].

Importing the module does not import concrete capabilities, install process handlers,
arm a device, start a server or build native assets. The CLI still explicitly registers
`clipboardCapability` and `captureRuntime.capability`; their IDs, defaults and override
selection are unchanged [observed: `src/index.ts`, `src/capabilities/runtime/registry.ts`,
`src/sim-pasteboard-reader.ts`, `src/capture/runtime.ts`].

### Dependency direction

The host composes the generic runtime and concrete capabilities. Each migrated
capability gets one entry point, such as `./capabilities/clipboard` or
`./capabilities/network-capture`. Generic runtime code must not import those implementations.
Capability types belong with the runtime implementation and may be imported with
`import type`; there is no second registry or cache of shared enabled state.
Each capability's `index.ts` explicitly exports its host-facing API. Its implementation
files import sibling leaves directly, avoiding cycles through the public entry point.
Capability-owned code and its callers move together; old root forwarding files and
the old `src/capture/` public barrel are removed. The network capture folder is named
`network-capture`; its registered capability ID remains `networkCapture`.
CLI, HTTP, WebSocket, security and UI adapters stay with the host
[confirmed: Gabe Debes, 2026-11-10].

The foundation includes the capability manager, not only its types and registry.
`runtime/manager.ts` owns preparation/publication/rollback transactions, loader
insertion and session ownership. `runtime/resources.ts`, `config.ts`, `state.ts`
and `lock.ts` own their existing helpers. `runtime/additional-dylibs.ts` retains the
concrete Simulator boot-inheritance policy. Callers import these modules directly;
the registry, armed-device set, pending-update
set, state filenames and lock namespace each have one implementation
[confirmed: Gabe Debes, 2026-11-10; observed: `src/capabilities/runtime/`].

App launching stays in the host. `src/launch-app.ts` owns its launch, stop and
URL entry points; `src/app-launch-host.ts` supplies the existing native app operations.
The internal `withAppLaunchState` transaction publishes before the host launch callback,
rolls back publication or launch failures, then calls the URL continuation outside
that rollback catch but under the same device lock. Capability-triggered relaunch and
device shutdown also keep their existing position inside the ownership transaction;
their native calls remain in the host helpers. Do not split these into separately
locked preparation and launch operations
[observed: `src/capabilities/runtime/manager.ts`, `src/launch-app.ts`, `src/app-launch-host.ts`].

### Migration order

Move the existing code in serial, independently reviewable layers. Do not begin the
next layer until the current head has been reviewed and its relevant CI is clear
[confirmed: Gabe Debes, 2026-11-10].

1. **Module foundation:** extract the unchanged types, registry/selection, capability
   manager and its preparation, config, ownership and lock helpers. Expose the module
   entry point and retarget all callers/tests before removing the old root modules. This is the
   implemented boundary; the consumer moves below are still planned
   [observed: `src/capabilities/`].
2. **Clipboard:** add `capabilities/clipboard/index.ts`, move its implementation
   behind that entry point, and derive reusable setup/recheck/retry/disposal policy
   from `src/clipboard-session.ts` into `runtime/session.ts`. Keep host input arbitration and process-handler
   ownership outside the generic manager. Preserve setup coalescing, reboot repair,
   disabled versus unmanaged behavior, foreign setup and owned cleanup; see
   [LLP 0010](0010-serve-sim-clipboard.explainer.md#set-up-at-session-start-re-checked-every-30-s).
   Move the reader, session, pasteboard I/O, native artifact lookup/build helper,
   Copy, Paste and shortcut policy into that folder. Remove the old reader/session
   and `sim-pasteboard*` root files. Actual HID dispatch, input turns and HTTP/UI
   adaptation remain with the host.
3. **Network Capture:** move the full existing `src/capture/` module into
   `capabilities/network-capture/`. Its `index.ts` explicitly exports the existing
   runtime/factory, errors, types and host-facing helpers. Keep implementation in
   sibling leaves, including the engine and store, and remove the old public barrel.
   Reuse the runtime definition/preparation API while preserving Capture's public
   cancellation queue and resource lifecycle; preserve
   [host resource lifecycle](#host-resource-lifecycle) and the policy in
   [LLP 0005](0005-serve-sim-network-capture.explainer.md).
   Keep one canonical `captureRuntime` instance. Native/Python asset sources and
   output paths must still resolve after the physical move; this does not change
   the native build/output layout
   [confirmed: Gabe Debes, 2026-11-10].

Here `capabilities/network-capture` means network capture. Native screen/video capture,
streaming and recording are separate subsystems and stay outside this module
[confirmed: Gabe Debes, 2026-11-10; observed: `src/capture/runtime.ts`, `src/native.ts`].

Camera can become a later sibling after these consumers establish the boundary.
Keychain stays outside this foundation. Do not add runtime controls or lifecycle
features solely for a future consumer. If either existing consumer needs new lifecycle
semantics, stop that extraction and identify the concrete behavior change first
[confirmed: Gabe Debes, 2026-11-10].

### Native paths and validation

Source ownership does not require changing native build or output directories.
Keep the existing `Sources/` trees, dylib/helper names and `dist/` paths during the
first moves. Moving a TypeScript file must not silently change asset resolution;
use the capability-local `runtime/assets.ts` anchor: the former `src/` base for source,
the output directory for flattened ESM/CJS bundles, and the real executable directory
for Bun-compiled programs. Compiled modules otherwise resolve beneath `/$bunfs/`,
where the native files are absent. A baseline probe reproduced that existing loader
lookup failure; using the executable directory fixes it while retaining `dist/`
and the shipped `Sources/` layout. The asset test exercises source, relocated
ESM/CJS and two-stage compiled output from an unrelated working directory
[observed: `src/capabilities/runtime/assets.ts`, `src/__tests__/capability-assets.test.ts`].
In particular,
do not import the host's HTTP/WebSocket `src/runtime.ts` just to obtain a path helper
[confirmed: Gabe Debes, 2026-11-10; observed: `src/capabilities/runtime/config.ts`, `src/runtime.ts`].

Each layer checks its public entry point against the canonical implementation, then runs the
existing capability, Clipboard and Capture ownership/rollback tests as applicable.
Validate source typechecking, lint and LLP references, plus the Node ESM/CJS
middleware, CLI, compiled executable and packed/vendored native asset paths.
Simulator CI remains a separate gate from the isolated test run
[confirmed: Gabe Debes, 2026-11-10].

## The problem

serve-sim fakes things inside apps: the camera, the pasteboard, whatever comes
next. Faking them means running code inside the app's own process, because the
APIs being replaced are in-process ones such as `AVCaptureDevice`.

The only mechanism for that is `DYLD_INSERT_LIBRARIES`, which dyld applies when
a process starts. Two facts follow, and they shape everything else:

- **A dylib cannot be inserted into a process that is already running.** The
  variable is read at `exec`. An app that is already up can only be reached by
  restarting it.
- **A device-wide insert reaches every process, not just apps.** Setting it with
  `launchctl setenv` means daemons and system services load it too.

## Why a capability loader at all

The second fact is the reason this indirection exists. A capability dylib links
real frameworks: the camera injector pulls in UIKit, AVFoundation, CoreMedia and
others. Inserting _that_ device-wide crash-loops system daemons. This was
observed as GSSCred crash-looping when an inserted image linked Foundation.

So the inserted image must be inert and dependency-free, and something else must
load the real work. That is the capability loader:

```
launchctl setenv DYLD_INSERT_LIBRARIES  →  libServeSimCapabilityLoader.dylib   (libSystem only)
                                              ↓ reads a config file
                                           dlopen(libSimCameraInjector.dylib)   (UIKit, AVFoundation, …)
```

The capability loader links **only libSystem**. Deferred capabilities are loaded through it. Startup capabilities are preloaded alongside
it and must also link only libSystem; their constructors delegate scope and configuration
checks to the loader before initializing.

## What the capability loader does

1. Its constructor runs, before `main`, in every process the simulator starts.
2. It refuses to do anything unless `TMPDIR` sits under
   `/Containers/Data/Application/`. That is what distinguishes an app from a
   daemon, and it is why daemons are unaffected.
3. It reads `SERVE_SIM_CAPABILITIES_CONFIG`, which must be an absolute path.
4. It hands off to the **main queue** and loads capabilities from there.
5. It watches the config directory for changes and reloads the config on that
   queue. The file may not exist yet, and atomic replacement keeps the watch
   intact because it follows the directory.

### Why the main queue

Loading from the constructor deadlocks. The app's launch holds the ObjC
`load_images` lock and wants dyld's loader lock; a `dlopen` running at the same
time holds dyld's and wants ObjC's. Neither proceeds, and FrontBoard kills the
app after 20 seconds with `0x8BADF00D`. This was observed in
`WidgetRenderer_Default`, which SpringBoard spawns for the home screen, and
presented as the whole simulator appearing frozen.

A background thread does not fix it, because the race is with the app's own
launch rather than with the constructor specifically. The main queue does fix
it: the block does not run until the app is past dyld and ObjC initialisation,
and it is queued at process start so it runs before work the app queues later.

The load happens **on** the main queue, not hopping to a background queue from
it. Hopping off reintroduces the race in a milder form. The `dlopen` is still in
flight when the app asks for a camera, and the ordering guarantee that makes
this work is lost.

## The config

One file per simulator, `capabilities-<udid>.conf`, written atomically by
serve-sim. One capability per line, tab-separated:

```
<scope>\t<dylib>\t<env>\t<delay-ms>
```

- **scope**: `all` for every app, `user` for apps the user installed and no
  Apple ones. A user app's executable lives under
  `/Containers/Bundle/Application/`; an Apple app ships inside the runtime, under
  `RuntimeRoot`. Anything else in this field loads nothing, so a config written
  by an older serve-sim is refused rather than misread.
- **dylib**: absolute path. A relative path is refused.
- **env**: `NAME=VALUE` pairs joined by `;`, applied with `setenv` before the
  `dlopen`.
- **delay-ms**: how long to wait before loading this one. Optional, defaults to 0. Delayed loads are scheduled on the main queue without blocking it.
  Pending and loaded paths are deduplicated, and delayed callbacks reject
  removed or reconfigured entries.

The capability loader reads at most 64KB and loads at most 64 capabilities, and says so
on stderr rather than truncating silently.

## Scopes, and what a capability may assume

A capability declares its scope; the caller does not choose it. Neither scope
needs the app to exist yet, so a capability can be armed before anything is
installed. That is what makes serve-sim usable in agent flows, where the app is
installed later by the agent rather than by the workflow.

Scope decides _which processes load the dylib_. It is not the same as "which app
this is about": the optional bundle id is a launch target and never narrows what loads.

## Arriving late

A capability loaded after the app has already asked a question cannot retract the
answer the app was given. An app that looks for cameras during launch and is told
there are none will show no camera, however correctly the dylib loads afterwards.

Two things mitigate this, and neither is perfect:

- The injector posts `AVCaptureDeviceWasConnectedNotification` once its swizzles
  are installed. That is AVFoundation's hot-plug signal, so an app that watches
  for cameras appearing, which is standard practice for camera UIs, picks it up
  without restarting.
- A command that targets one app can restart it, which puts the capability loader in at
  `exec` and removes the timing question for that app.

An app that asks once at launch and never listens again can only be reached by
restarting it. That is a property of the app, not something serve-sim can fix.

The clipboard reader is armed the same way, but a clipboard read never restarts
an app. An app that already has the capability loader picks up the reader when
its config changes. An app that started before the session armed the loader has
no loader, so it has no reader until the user restarts it.
[LLP 0010](0010-serve-sim-clipboard.explainer.md#reads-never-restart-apps)
explains why.

## Lifecycle

The insert is machine-wide state on the simulator, so it must be owned by
something that reliably removes it:

- The session arms the capability loader before apps launch, even with no capabilities
  enabled. Stopping the camera leaves it armed until session teardown.
- Re-executed stream helpers carry `SERVE_SIM_STREAM_HELPER=1` and skip arming,
  because they can outlive the session that owns the insert.
- The process that arms it registers the teardown first, on `exit` and on
  `SIGINT`/`SIGTERM`/`SIGHUP`. The signal handlers disarm directly, because
  spawning `simctl` from an exit handler does not always finish.
- An embedded `simMiddleware` does not own the host's signals, so its clipboard
  setup registers only the `exit` teardown. That teardown is synchronous, like
  the serve-sim CLI's own `exit` fallback. It runs when the host ends with
  `process.exit` or returns normally
  ([LLP 0010](0010-serve-sim-clipboard.explainer.md)).
- `--detach` never arms. The command exits once the helper is streaming, so no process
  is left to disarm it. `--install-app-path`, `--launch-app-identifier`, `--launch-arg`,
  `--open-url`, `--enable` and `--disable` are rejected with `--detach`.
- On startup, a capability loader left behind by an earlier session whose dylib no
  longer exists is cleaned up.
- Live session PIDs are recorded independently of capabilities, so an idle
  session still owns the insert. State updates and teardown share a device lock.
- Capability records carry the pid that enabled them. A record with no owner
  (`null`) outlives the command that created it; a record owned by a session is
  released when that session exits, including its host helper. The insert is
  removed only when no live session or capability needs it.

For the CLI's boot/install/launch ordering and readiness boundary, see
[LLP 0011](0011-serve-sim-session-startup.explainer.md) (Draft).

## Not there yet

Recorded so the gap between this document and the code is visible rather than
forgotten:

- **The per-launch path inserts the capability dylib alongside the capability loader.**
  `childLaunchEnv` puts both in `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES`. It should
  insert the capability loader alone and let it load the capability, so there is one
  loading path rather than two.
- `+[AVCaptureDevice defaultDeviceWithMediaType:]` is not swizzled, only the
  `deviceType:mediaType:position:` form, so an app using the older API sees no
  camera.

## Startup capabilities

`loadPhase: "startup"` preloads a dependency-free capability image so its hooks can run
before app constructors and Objective-C `+load`. Its constructor calls
`serve_sim_startup` through `startup-capability.h`; the loader matches the callback's
actual image against configuration, checks app scope, and applies environment values
before invoking initialization. This path never calls `dlopen` or waits for the loader's
constructor. An absent loader or config leaves the startup image inert.

The config record is `startup\t<scope>\t<dylib>\t<env>\t0`. Older loaders reject its
unknown leading token instead of silently loading startup work later. The deferred path
ignores these records, including config updates in already-running apps. Capabilities
with only a startup record require an app relaunch; removing config cannot undo
existing session state.

Network capture uses `startupAndDeferred`: the manager writes both the startup record
and a deferred record for the same image. New apps receive the image at `exec`, so
startup requests can be captured. An app that already carries the loader sees the
new deferred record and `dlopen`s the image on its main queue. The image's startup
callback then checks the startup record and installs the proxy hook. An image
already inserted at `exec` is deduplicated by dyld. Sessions or configurations
created before a late load remain unchanged, so those requests can be missed.

The capability manager owns all insert-list updates. A separate insert ownership file
retains startup paths until launchd cleanup succeeds, even when their capability owner
has exited or their config has been removed. Unrelated inserted libraries are preserved.
Each update reads the insert fresh and skips a `launchctl setenv` whose value is already
in place, so a launch with unchanged capabilities does not write launchd state. A reboot
clears those values, so the next update writes them again.
`SERVE_SIM_ADDITIONAL_DYLIBS` adds caller-owned paths to that insert list alongside
the loader and startup capability images. Cleanup by a process with that variable set
preserves its explicitly requested paths, even when an enabled capability also records
one as a managed image. Caller paths are excluded from stale-loader detection
[observed: `src/capabilities/runtime/manager.ts` `armInsert`, `withoutOurs`,
`removeReleasedStartupSync`, `disarmStaleCapabilityLoader`].

Capture's startup image resolves existing Objective-C runtime functions and enumerates
session factory methods without sending Objective-C messages during initialization.
Proxy dictionaries are constructed only when those factories are called. Its build checks
that no framework or Objective-C runtime dependency has been linked into the image.

## Host resource lifecycle

Capability preparation runs under the device launch-state lock. Resource callbacks
must not reacquire that lock or enqueue a runtime operation. A preparation may
return `committed`, `failed`, and `rollback` callbacks: publication calls
`committed` after configuration is installed, reports errors through `failed`,
and calls `rollback` only when the prior configuration was restored. Rollback
releases only resources allocated by that preparation. An uncertain rollback
retains resources for a later explicit cleanup.

Disabling removes the capability configuration before stopping its host resources.
Exclusive capabilities, including network capture, cannot replace another live
session's registration; local cleanup preserves a foreign registration. Capture
keeps its public request queue for cancellation while the registry and runtime
share the same resource callbacks and launch-state lock.
