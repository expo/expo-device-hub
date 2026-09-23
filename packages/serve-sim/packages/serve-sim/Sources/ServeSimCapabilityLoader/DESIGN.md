# The capability loader

The capability loader loads capabilities into eligible simulator apps while keeping
system daemons free of framework dependencies.

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
others. Inserting *that* device-wide crash-loops system daemons. This was
observed as GSSCred crash-looping when an inserted image linked Foundation.

So the inserted image must be inert and dependency-free, and something else must
load the real work. That is the capability loader:

```
launchctl setenv DYLD_INSERT_LIBRARIES  →  libServeSimCapabilityLoader.dylib   (libSystem only)
                                              ↓ reads a config file
                                           dlopen(libSimCameraInjector.dylib)   (UIKit, AVFoundation, …)
```

The capability loader links **only libSystem**. It is the one dylib in the insert. Every
capability is loaded by it, never inserted alongside it.

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
- **delay-ms**: how long to wait before loading this one. Optional, defaults to
  0. Delayed loads are scheduled on the main queue without blocking it.
  Pending and loaded paths are deduplicated, and delayed callbacks reject
  removed or reconfigured entries.

The capability loader reads at most 64KB and loads at most 64 capabilities, and says so
on stderr rather than truncating silently.

## Scopes, and what a capability may assume

A capability declares its scope; the caller does not choose it. Neither scope
needs the app to exist yet, so a capability can be armed before anything is
installed. That is what makes serve-sim usable in agent flows, where the app is
installed later by the agent rather than by the workflow.

Scope decides *which processes load the dylib*. It is not the same as "which app
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
- `--detach` never arms. The command exits once the helper is streaming, so no process
  is left to disarm it. `--launch-app-identifier`, `--launch-arg`,
  `--open-url`, `--enable` and `--disable` are rejected with `--detach`.
- On startup, a capability loader left behind by an earlier session whose dylib no
  longer exists is cleaned up.
- Live session PIDs are recorded independently of capabilities, so an idle
  session still owns the insert. State updates and teardown share a device lock.
- Capability records carry the pid that enabled them. A record with no owner
  (`null`) outlives the command that created it; a record owned by a session is
  released when that session exits, including its host helper. The insert is
  removed only when no live session or capability needs it.

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
