# Review guide

This file tells a reviewer, human or automated, what to look for in a
serve-sim pull request. Every rule below comes from a finding a reviewer
made on a PR, or hit while verifying one locally. When a new finding
repeats, add it here, or better, turn it into a lint rule or a test and
delete the prose.

Lint already covers formatting, filename case, and import boundaries.
Do not flag those by hand. Flag behavior, safety, and evidence.

## What a PR must show

- **Evidence matches the change.** A CLI change shows the command and its
  output. A UI change shows a screenshot or video. A native change names
  the simulator and Xcode version it ran on. "Builds and typechecks" is
  not evidence.
- **A failing test came first** where a cheap test path exists. New
  failure paths need coverage. A flag that latches a session into a
  degraded state needs a test in both directions: that it latches, and
  that later calls short-circuit through it.
- **Tests exercise the shipped code.** A fixture that redefines the
  function under test only tests the stub. Import the production file
  and drive the real symbol.
- **One behavior change per PR.** A fix for one device class must not
  change the path for every other device class. If it does, the PR says
  so and shows a tap, drag, and scroll on a non-affected device.
- **The first MJPEG frame after connect is a cached seed, not the live
  screen.** After switching a simulator to dark mode, `simctl ui <udid>
  appearance` read back `dark` while the first frame from a fresh
  `stream.mjpeg` connection was still the earlier light frame, byte for
  byte. Evidence built from the first frame proves nothing. Use a later
  frame, or `simctl io <udid> screenshot` on your own device.

## Native code: `Sources/`

The Swift and Objective-C code loads private Apple frameworks through
`dlopen` and `dlsym`, reads raw memory layouts, and injects HID input.
A wrong assumption here crashes the whole serve-sim process or silently
drops input. Review for these:

- **Gate private frameworks to the devices that need them.** Loading
  CoreDevice for every session widened the crash surface to every iPhone
  and iPad. Read the device profile first and touch the bridge only for
  devices that report the capability.
- **Check availability before anything moves.** A pose request that
  moves the hinge and then fails on the table sensor leaves the device in
  a state nobody asked for. Availability checks come before the first
  mutation.
- **On failure, read the real state back.** Do not clear state to
  `undefined` and broadcast that. The device still has an angle. Clearing
  it also blocked the retry, because the client refused the next command
  locally.
- **Cleanup restores the whole original state.** Restoring only the hinge
  angle dropped the pose and table mode the test started in. Restore by
  pose when a pose was set.
- **Optional-returning symbols get a nil check.** Read the result type in
  the mangled name. `Sg` marks `Optional`, as in `...ACSg...tcfC` for a
  failable initializer. `tcfC` alone only marks an allocating initializer
  and says nothing about the result. When the result is `Optional`,
  check the nil tag before use. Passing the buffer through as a
  non-optional sends the nil tag bytes as a value.
- **Validate runtime value sizes before writing into fixed buffers.** A
  two-word stack buffer plus a future layout change is a stack overwrite.
  Check the size at resolve time and mark the capability unavailable when
  it does not fit.
- **Resolve symbols once.** Use `dispatch_once` for `dlsym` and cache
  negative results. One shim ran five `dlsym` calls on every hinge query.
- **An optional capability must not disable an unrelated one.** Requiring
  the keyboard symbols in `setup` took touch down with it. A single
  missing swipe-lock symbol in an all-or-nothing gate disabled all Duo
  touch. Keep the digitizer as the hard gate and treat the rest as
  optional at setup time.
- **A cached failed `Task` is a permanent, silent failure.** When
  `setup` throws once, every later input call rethrows for the life of
  the session, and `guard` swallows it. Surface `inputUnavailable` on the
  WebSocket config and log which transport was missing.
- **Await setup before injecting input.** Ordering that holds because of
  the current call sequence in `device-session.ts` is an accident, not a
  guarantee. Every input method awaits `setup.value`, not only
  `setScreen`.
- **No barrier round trip per event in a hot path.** One `type` command
  sent 26 barriers. Batch to the end of the sequence.
- **A failed `dlopen` surfaces its reason.** `SimFrameworks.load()`
  discards every result. When SimulatorKit is missing, from a bad
  `DEVELOPER_DIR` or a new Xcode layout, the user later sees "Device
  <udid> not found" from `findSimDevice`, which points the wrong way.
  Record which path loaded, and throw with the `dlerror` for each path.

## Server: `packages/serve-sim/src/*.ts`

- **Malformed input never crashes the process.** HID calls are guarded
  in-process. A bad frame from any client returns an error and the
  server keeps streaming.
- **A setup failure must not hang session start.** A rejected `setScreen`
  inside `captureStart` left the middleware answering 503 "starting"
  forever. Log once, disable input for that session, and let capture
  continue.
- **Every HID method logs its rejection.** Most go through `guard`.
  `setScreen` catches setup failures itself, logs once, and latches
  `inputUnavailable`; that is deliberate, not a bypass. A method with
  neither path is the finding.
- **Validate once.** Panel id, endpoint, and method validation lived in
  two places with the same status codes and strings. Extract one helper
  or delete one copy.
- **Subcommands resolve the device argument the same way.** `hinge`
  passed a resolved device while `tap`, `rotate`, and `gesture` passed
  the raw argument. Pick one behavior.
- **Cache keys stay cheap.** A cache key that reads and regex-scans a
  whole PDF on every asset request is not a cache.

## Client: `packages/serve-sim/src/client/`

- **Match replies on `ok === false`, not on echoed fields.** A rejected
  hinge request returned no `angle`, so the acknowledgement handler never
  matched, the control stayed pending for five seconds, and the real
  error was never shown.
- **One panel's silence must not downgrade the session.** A watchdog that
  maps 4 s of silence on the inactive Duo panel to `onAvccError` dropped
  the whole session to MJPEG permanently. Use per-panel `timeout`
  semantics, or arm the timer only for the intended panel.
- **Do not gate recovery on an equality that can never hold.** Clearing a
  handoff flag only when the broadcast angle equals the requested angle
  left taps dead after a failed pose, because the server broadcast no
  angle at all.
- **Keyboard chords must not collide with the browser.** Cmd+1 to Cmd+5
  switch tabs in Safari, Chrome, and Firefox on macOS, and the browser
  handles several before the page sees `keydown`.
- **Name constants.** A bare `580` in layout code needs a name and the
  reason for the value.
- **Callbacks that depend on broadcast config read from a ref.** A
  callback that changes on every config broadcast re-registers window
  listeners on every broadcast.

## Tests: `src/__tests__/`

- **Preconditions gate only the tests that need them.** A stale
  `SERVE_SIM_DUO_E2E_DEVICE` skipped an entire suite, including tests
  that run on any simulator. Compute readiness from what each test
  needs, and use `test.skipIf` per test for the extra requirement.
- **Under `SERVE_SIM_E2E_REQUIRED=1` a missing precondition fails.** It
  never skips. Do not add a skip path that hides a missing simulator or
  build artifact from CI.
- **E2E cleanup restores by pose**, and it runs in `finally`.
- **Plain TypeScript failure paths get a child-process test.** The
  `*.child.ts` fixtures under `src/__tests__/fixtures/` run without a
  simulator. Use them for latches, state machines, and route parsing.
- **Tests never read the shared state folder.** `stateDir()` defaults to
  `$TMPDIR/serve-sim`, which every session on the machine shares. A test
  that hits a route calling `readServeSimStates()` without
  `useTempStateDir()` from `helpers.ts` can attach to another session's
  server. `readiness-endpoints.test.ts` did, and failed with 200 instead
  of 503.
- **Start servers on a port you own, with your own state folder.**
  `killOwnListeners()` SIGKILLs any listener a state file records. With
  the shared folder, that includes another session's server. Take a free
  OS-assigned port with `freePortAsync()` and a private
  `SERVE_SIM_STATE_DIR`.

## Assets, size, and licensing

- **No Apple assets in the tarball.** The package is Apache-2.0 and
  publishes to npm with public access. Load device models and DeviceKit
  artwork from the installed Xcode at runtime, with a flat fallback.
- **No multi-megabyte base64 in the client bundle.** The client HTML is
  inlined into the CLI, so a 5.9 MB model inflated every preview load for
  every device type. Serve large assets from an authenticated route with
  an ETag and fetch them lazily.
- **Unreferenced assets go.** An SVG that no code references is deleted,
  not shipped.
- **PR validation notes belong in the PR**, not in user-facing docs.

## Severity

- **P1:** data loss, a crash of the serve-sim process, input silently
  dropped, a device left in a state the user did not request, licensing.
- **P2:** a failure that is visible but wrong, missing coverage on a new
  failure path, duplicated validation, a behavior change outside the
  stated scope.
- **Nit:** naming, comments, a constant without a reason. Post these only
  when the PR is otherwise ready.
