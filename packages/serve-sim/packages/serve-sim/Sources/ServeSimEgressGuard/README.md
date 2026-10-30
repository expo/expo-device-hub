# Resident egress guard

The guard stays loaded while its policy switches between pass-through and block.
This directory contains the native dylib, shared policy page, control helper and
host tests. [LLP 0007.000](../../../../../../llp/0007.000-runtime-egress-guard.explainer.md)
describes the capability-loader and startup/adoption integration.

Explicit startup requires resident enrollment and a native policy self-check
before app actions or ready output. Private adoption checks compatibility before
claiming, then publishes and self-checks policy before capture/video setup;
failure leaves the claim consumed. There is no bypass flag. Uninstrumented sessions without an egress
request retain their existing path, including one-shot adoption, capture and
recording. The EAS cold fallback is unchanged.

The guard must be preloaded at process startup. Its startup capability record
supplies `SERVE_SIM_EGRESS_POLICY_FILE`, pointing to a private control page created
before startup. Host tests use an explicit compile-time constructor adapter;
production initialization requires the loader's all-process startup entry point. The host control helper requires an explicit
`create /absolute/page passthrough|block`; `set` publishes a mode/generation on
the same inode. There is no warmup default. Missing or invalid state blocks
covered remote attempts. Unix sockets, files and loopback destinations continue.
`status` checks the page, not whether the guard is loaded in another process.
The Simulator `serve-sim-egress-check` helper verifies that its startup callback
mapped the expected page in the pinned guard image and reports the observed mode
and generation. Host admission checks compare these with enrollment under the
device lock. The helper does not claim to inspect every process or drain traffic.

Pass-through is an atomic check followed by the original operation. Block mode
checks supplied destinations on connect/connectx and addressed sendto/sendmsg,
including connect/sendto/sendmsg NOCANCEL symbols. It does not interpose send,
write or writev, or inspect an existing connected peer. No fd cache is used.
Destination classification follows build-tools' guard; event
logging/reporting is not implemented here.

Existing connections and operations already in flight may continue after enable.
This is the intended boundary, not an instantaneous network cutoff. Direct
syscalls, sendfile/sendmsg_x, other interposers introduced by late dlopen,
uninstrumented processes and concurrent fd replacement between check/use are
outside coverage. Simulator-external processes are outside the guard. Never
unlink, replace or truncate a live page: existing processes keep its mapping;
truncation can fault. The boot owner must retain these assets until the bound
Simulator boot is confirmed dead.

Run on macOS with clang and Python's standard library, with no Simulator:

```sh
python3 tests/run.py \
  --baseline-dir /absolute/read-only/build-tools/resources/egress-guard \
  --evidence /absolute/new/evidence-directory
```

The runner copies baseline source, compiles only into a private `/tmp` directory,
uses loopback peers, and deletes only its freshly created build directory after
retaining logs/results outside the repo. Caller work directories are not accepted.
Behavior tests classify one loopback test peer as remote; benchmarks use
unmodified classification and an unmodified copy of today's guard. `--skip-benchmark`
runs behavior checks only. Performance compares no guard, today's guard, resident
pass-through and resident block in randomized paired rounds.

The controller fixture changes policy through the actual helper while one live
guard retains its TCP/UDP sockets. New attempts follow the published policy while
the existing sockets continue. This checks one process's observation, not
all-process observation. A separate short mapped-IPv6 TCP test checks
zero-filled classification with denied and permitted loopback cases.

Run the runner's cleanup tests without clang or networking:

```sh
python3 tests/runner_test.py
```

These tests establish **macOS host mechanism only**, not Simulator enforcement
or hosted acceptance. Production acceptance requires final-source cost checks,
process coverage, boot lifetime and proxy readiness on
the target Simulator. A measurable pass-through regression against no guard, or
block regression against today's guard, blocks admission. Warm readiness must
self-check the resident image and control page; failure requires cold fallback.

A native mechanism check requires a coordinated, dedicated Simulator window:

The Simulator harness requires a loader exporting `serve_sim_startup_all_processes`.
The runner checks that entry point before creating a device and rejects incompatible
loaders. The presence of these tools does not establish Simulator or benchmark results.

```sh
python3 tests/simulator.py \
  --runtime com.apple.CoreSimulator.SimRuntime.iOS-26-4 \
  --evidence /absolute/new/evidence-directory
```

It builds private copies of the shipped images and helpers, creates its own device,
and pauses for `continue` after boot so that device can be attached to the Device
panel. It uses sockets bound to this machine, confirms shutdown with the boot probe,
and removes only the device and temporary outputs it created. Uncertain cleanup
retains the outputs. This checks one non-app process's policy observation; it does
not establish all-process coverage, performance or hosted acceptance.
