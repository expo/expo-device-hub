# PR #254: refusal-frame delivery reproduction

This bundle supplies the diagnostic protocol behind [PR #254](https://github.com/expo/expo-device-hub/pull/254), raw trial events, source hashes and exact rerun commands. It uses owned loopback listeners and private state files. The `xcrun` shim supplies one fake booted device and refuses all other calls; the diagnostic never boots or drives a Simulator.

Download the pinned evidence tree using the [bundle instructions](../README.md),
keeping it separate from your production source checkout.

## Results and what they establish

The fresh, frozen 80-trial run used Node 24.21.0, Bun 1.3.14, the built CLI from `3c801d389caa6d403ac54bf39d670a44aec24288`, and ten trials for every adapter/client cell. Both adapter and client orders reversed each round. See [fresh-results.json](fresh-results.json) for every trial, close code, CLI exit status, socket event and source hash.

| Observed outcome | Baseline adapter | Final adapter `3c801d389` |
| --- | ---: | ---: |
| Active CLI received abnormal close 1006 and exited 0 | 2 / 10 | 0 / 10 |
| Active CLI received refusal 1013 and exited 1 | 8 / 10 | 10 / 10 |
| Passive client received refusal 1013 | 10 / 10 | 10 / 10 |
| Trial timeouts | 0 | 0 |

The baseline adapter is the exact source from `128085cc165cee6ad0868e9cd8661d8e2427c1f4`; its `server-input.ts` is byte-identical to #243 at `9f49f1f4ab30815515bfe967424f1387db6d10af`. The final adapter is exact published source from #254. Each is bundled to CJS by Bun and executed with Node's real HTTP/TCP implementation. The actual `tap 0.5 0.5 -d <mock-device>` CLI is run, rather than a reimplementation of its timer behavior.

The transport diagnostic refuses immediately after upgrade and sends no `0x83` admission frame. It isolates refusal delivery; it does not instantiate the full eight-client pool. The committed Simulator E2E described below covers that pool separately.

A separate raw peer deliberately leaves its TCP write side open and keeps sending masked input after receiving the close frame. [fresh-stubborn-peer-results.json](fresh-stubborn-peer-results.json) shows the final transport destroyed at **1,001.8 ms**. The end-only prototype still retained its readable socket at **1,200 ms**. A one-second timer is a cleanup deadline subject to event-loop scheduling; the observation is not an exact real-time guarantee.

These are small diagnostic samples. An active baseline run can pass every trial, and rerunning does not promise exactly two failures. Do not increase the round count until a preferred result appears. This change does not fix the CLI's separate open-before-admission behavior.

## Fast contract reproduction from the production PR

Prerequisites: macOS, Git, Node 24.21.0 and Bun 1.3.14 on `PATH`. Other maintained Node versions may work, but the recorded run used those exact versions.

In a fresh checkout of `expo/expo-device-hub`:

```sh
git fetch origin 128085cc165cee6ad0868e9cd8661d8e2427c1f4 3c801d389caa6d403ac54bf39d670a44aec24288
git checkout --detach 3c801d389caa6d403ac54bf39d670a44aec24288
bun install --frozen-lockfile
cd packages/serve-sim
bun run test -- packages/serve-sim/src/__tests__/raw-hid-socket.test.ts
```

Expected result: **6 pass, 0 fail**. These tests build their Node wire fixture themselves; the fast contract run does not require the native addon or a Simulator. It checks code 1013 and the exact refusal reason over a real Node socket, immediate logical capacity release, stopping further input, repeated close calls, cleanup timer cancellation and forced cleanup of an unresponsive peer. The 6-test command was rerun while preparing this bundle and passed with 19 assertions.

The suite and real Node fixture live in the production PR at:

- `packages/serve-sim/packages/serve-sim/src/__tests__/raw-hid-socket.test.ts`
- `packages/serve-sim/packages/serve-sim/src/__tests__/fixtures/raw-hid-close.child.ts`

## Rerun the source-level comparison

Use the production checkout above and this downloaded evidence directory. The CLI bundle must exist. Build it once with Xcode's command-line tools available; the original Simulator validation used Xcode 26.4 (17E192).

```sh
# Run from the production checkout's repository root.
task_repo="$PWD"
task_evidence="/absolute/path/to/this/254-directory"
task_results="$(mktemp -d "${TMPDIR:-/tmp}/hid-close-repro.XXXXXX")"
cd "$task_repo/packages/serve-sim"
bun run build
cd "$task_repo"

bun run "$task_evidence/build-adapters.ts" "$task_repo" "$task_results"
node "$task_evidence/run.cjs" "$task_repo" "$task_results" baseline,end-only,grace,final 10
node "$task_evidence/stubborn-peer.cjs" "$task_results"
```

This creates `results.json`, client JSONL traces, `source-variants.json` and `stubborn-peer-results.json` in the output directory. Review `cells` and the individual `trials`; keep failed and passing baseline trials. The CLI/source hashes are measured before and after the comparison to detect accidental mutation. No source checkout is rewritten by the harness; the pinned adapter sources are materialized in the output directory from Git objects.

Expected final contract: refusal code **1013**, CLI exit **1**, no trial timeout, and deliberate half-open TCP peer destroyed after roughly one second. The runner exits nonzero on a timeout or source/CLI mutation. It records refusal outcomes without suppressing or forcing failures. The stubborn-peer runner exits nonzero if the end-only socket has already closed or either bounded variant has not closed by its 1,200 ms snapshot; a sufficiently busy event loop can invalidate that timing probe.

`baseline` and `final` use pinned repository source. `end-only` removes `destroySoon` without bounding transport retention. `grace` is the archived preliminary bounded-cleanup prototype used in the original diagnostics; the final implementation additionally guards repeated close calls, clears buffered input and cancels its timer on TCP close. Both prototype files are included so a reviewer can inspect the exact experimental code.

The historical original comparison ran baseline/end-only first (40 trials), followed by the bounded prototype (20 trials), rather than interleaving all four variants. To repeat that order, build adapters in two distinct result directories, then use `baseline,end-only 10` in the first and `grace 10` in the second. The original records are [historical-results.json](historical-results.json), [historical-grace-results.json](historical-grace-results.json) and [historical-stubborn-peer-results.json](historical-stubborn-peer-results.json). They are separate from the fresh published-head run.

Raw event data are retained. Machine-local prefixes were removed from historical hash labels; the CLI's stderr is represented by its `Error:` line because Node otherwise prints the minified CLI source and local stack paths. That source dump is unnecessary to interpret the close code or exit status.

## Optional actual Simulator pool test

After the full build, boot a Simulator that belongs to your test run and set its exact UDID. Do not target a shared `booted` device. The E2E wrapper creates a private state directory, builds its UIKit fixture and cleans up its own server.

```sh
cd "$task_repo/packages/serve-sim"
SERVE_SIM_TEST_UDID=YOUR_OWNED_SIMULATOR_UDID bun run test:e2e -- \
  packages/serve-sim/src/__tests__/hardware-keyboard-shift.e2e.test.ts \
  -t 'tap reports a full input connection pool'
```

The pool test first holds eight sockets until each receives admission `0x83`. Expected ninth `tap` result: nonzero exit and `Simulator input rejected` on stderr. The PR's recorded full keyboard suite was 11 passing tests; a filtered run only covers the pool case. This bundle does not claim a new Simulator run.
