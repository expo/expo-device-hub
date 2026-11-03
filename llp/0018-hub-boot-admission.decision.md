# LLP 0018: Hub boot admission

**Type:** Decision
**Status:** Draft
**Systems:** Hub, AppleUtils, AndroidUtils
**Author:** Claude Code (Claude Opus 5.5), at the request of a device-host operator
**Date:** 2026-11-01
**Related:** LLP 0000

## Summary

A host can cap how many simulators and emulators are booted or starting at once. The cap is a policy file owned by the OS account. Every Hub process under that account checks it before each route that boots a device (see [Gated routes](#gated-routes)), so several Hubs on one machine share one budget. Without the file nothing changes.

Upstream maintainers have not reviewed this design, so it stays `Draft`.

## Context

T3 boots devices by sending `POST /api/devices/boot` (or `/api/devices/create`) to a Hub before its own session exists. On a shared device host, several Hub processes run under the same OS account, one for each T3 namespace or environment. Each boots devices without knowing about the others. Too many emulators at once exhaust the host's memory [inferred].

T3 treats an `{ ok: false, error, errors }` response (HTTP 200) as a boot failure and shows `error` and `errors` to the user. It also classifies failures by words such as "timed out" [inferred: from T3 Code's public `apps/server/src/device/DeviceHubOperations.ts`; not checked in this repository]. A refusal therefore uses that shape and avoids those words.

## Contract

### Host policy

- The file is `~/.expo/device-hub/host-policy.json`, containing `{"maxVirtualDevices": <integer >= 0>}`. The home directory comes from the OS account's passwd entry (`os.userInfo().homedir`), not `$HOME`. Hubs started with a per-environment `HOME` still find the one policy and cannot move it. No environment variable or CLI flag sets, overrides or unsets it [observed: `defaultBootAdmissionPaths` in `src/server/boot-admission.ts`].
- The file is read on every admission, so an edit applies to the next boot [observed: `readPolicy` in `src/server/boot-admission.ts`].
- No file: boots are unconstrained. Admission takes no lock, lists no devices and writes nothing. This is the default for every host; the Hub never creates the file [observed: `createBootAdmission` in `src/server/boot-admission.ts`; test "boots run unchanged, without reading occupancy or writing state" in `src/server/__tests__/boot-admission.test.ts`].
- A file that cannot be read, is not JSON, or has no valid `maxVirtualDevices` refuses every boot, and the error names the file and the problem. `0` is valid and refuses every boot except a reopen of a device that is already counted (see [Reopen](#reopen)) [observed: `readPolicy` and `decide` in `src/server/boot-admission.ts`].
- An account without a passwd entry has nowhere to keep a policy, so its boots are unconstrained [observed: `defaultBootAdmission` in `src/server/boot-admission.ts`].

The guarantee covers the Hub processes of one OS account. Other accounts, other tools that run `simctl` or `adb` directly, and physical devices are outside it [observed: `defaultBootAdmissionPaths` in `src/server/boot-admission.ts` and `readProcessTable` in `src/server/process-table.ts` for the account; admission runs only on the routes under [Gated routes](#gated-routes)].

### Gated routes

Admission runs before every Hub route below, each of which boots a device [observed: `src/server/device-actions.ts`, `routeRequest` in `src/server/index.ts`, and `src/server/vendor-boot-gate.ts`]:

| Route                                   | Body                                    | Admitted as                                           |
| --------------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| `POST /api/devices/boot`                | `{platform, id, name}`                  | iOS by `id` (the UDID); Android by AVD `name` or `id` |
| `POST /api/devices/create`              | `{platform, name, runtime, deviceType}` | a new device; Android by AVD `name`                   |
| `POST /vendor/serve-sim/grid/api/start` | `{udid}`                                | iOS by UDID                                           |
| `POST /vendor/serve-emu/api/avds/start` | `{avd}`                                 | Android by AVD name                                   |

The last two routes belong to the vendored servers. serve-sim's `grid/api/start` boots a shut-down simulator before it streams it [observed: the `grid/api/start` route and `startDeviceInProcess` in `packages/serve-sim/packages/serve-sim/src/middleware.ts`]. T3 calls it to attach an iOS stream, normally to a device that is already booted [inferred: from T3 Code's public `apps/server/src/device/DeviceHubOperations.ts`; not checked in this repository]. serve-emu's `api/avds/start` launches an emulator [observed: the `api/avds/start` route in `packages/serve-emu/packages/serve-emu/src/middleware.ts`]. The Hub gates both without changing the servers:

- Without a policy file, the request is forwarded untouched and its body is not read.
- With one, the Hub reads the body (at most 64 KiB; a larger body gets a 413), admits the device it names, and forwards a request rebuilt from the same bytes. A body without a UDID or AVD name is forwarded, and the server rejects it.
- The Hub answers a refusal itself, in the server's failure shape `{ok: false, error}` and with the status the server uses for a failed start: 500 for serve-sim, 400 for serve-emu. The server never sees the request.
- A device that already counts, such as a booted simulator T3 attaches to, passes as a [reopen](#reopen).
- After the server answers, the attempt is finished. For serve-emu, the `serial` from a successful answer is recorded first.

serve-emu's stream `ensure` does not boot. It attaches only to a device that adb already lists online, and otherwise fails [observed: `ensure` and `resolveSerial` in `packages/serve-emu/packages/serve-emu/src/middleware.ts`].

One route boots a device the Hub cannot name. Outside a single-device session, a `GET` of the serve-sim preview root spawns `serve-sim --detach` when no helper is running. With no device named and none booted, that command boots a default simulator it picks itself [observed: `ensureHelperSpawned` in `src/server/serve-sim.ts`; `detach` in `packages/serve-sim/packages/serve-sim/src/index.ts`]. Admission cannot name that device, so on a host with a policy the preview root spawns no helper; the preview streams through the gated in-process `grid/api/start` instead [observed: `handleSimRequest` in `src/server/serve-sim.ts`; the in-process start in `packages/serve-sim/packages/serve-sim/src/middleware.ts`]. Without a policy the helper spawns as before.

### What counts

One budget covers both platforms. A workload counts when any of these shows it:

- **iOS:** every simulator in `xcrun simctl list devices --json` whose state is not `Shutdown`. `Booting` and `Shutting Down` count.
- **Android:** every adb serial matching `emulator-<port>`, in any adb state (`device`, `offline`, `unauthorized`), and every emulator process in this account's process table (see [Android identity](#android-identity)). An emulator process counts before adb lists it, while it starts and after adb lost it. Serials of physical devices are ignored.
- **Attempt records:** each admitted boot or create writes `attempt-<pid>-<random>.json` in `~/.expo/device-hub/boot-admission/` (directory mode `0700`, files `0600`, written by temp file and rename).

The process table is `ps -A` filtered to this OS account's real user id (BSD `ps -U` without `-x` may leave out processes without a terminal, such as a detached emulator [inferred: from the BSD `ps` manual; not run on macOS here]), with their state, start time and command line. Like `simctl` and `adb`, which list this account's devices, it leaves other accounts' emulators out, as the guarantee does [observed: `readProcessTable` in `src/server/process-table.ts`].

A platform whose tool is not installed (`ENOENT` when spawning `xcrun` or `adb`) contributes nothing. Any other listing failure refuses the boot, because occupancy is unknown. `ps` has no such exception: without the process table, neither emulator processes nor liveness are known, so any `ps` failure, a missing `ps` included, refuses the boot. Each `adb` and `ps` call is limited to 30 seconds, as `simctl` calls are, so a stalled tool fails the listing instead of holding the lock. Admission never shuts a device down to make room [observed: `nativeHost`, `decide` and `countWorkloads` in `src/server/boot-admission.ts`; `listAdbDevices` in `packages/@expo/hub-android-utils/src/list-adb-devices.ts`; `READ_PROCESS_TABLE_TIMEOUT_MS` in `src/server/process-table.ts`].

When the count is at the limit, the boot is refused before any native boot step runs:

```
Device host capacity reached: <count> of <max> virtual devices are booted or starting on this host. Shut one down before booting <name>.
- <one line per counted workload>
```

### Android identity

Every emulator instance counts on its own. Two instances never merge because their AVD names match: two emulators of one AVD (with `-read-only`) take two slots [observed: `nativeWorkloads` in `src/server/boot-admission.ts`].

- adb lists each instance by its serial `emulator-<port>`, plus its AVD name while it is online.
- An emulator process is a command line whose program is `emulator` or `qemu-system-*` and that names an AVD with `-avd <name>` or `@<name>`. `-port <P>` (or `-ports <P>,<adb>`) gives its console port. Processes are one instance only on evidence: the same AVD on the same console port, or a child process of an emulator process for the same AVD (by parent pid, such as the launcher and its qemu child) whose ports do not differ. Two portless processes of one AVD, such as two `-read-only` instances, count as two [observed: `parseEmulatorArgs` in `packages/@expo/hub-android-utils/src/emulator.ts`; `emulatorProcesses` in `src/server/boot-admission.ts`].
- A process with port `P` is the instance adb lists as `emulator-<P>`, unless adb names a different AVD there. A process without a port joins an adb instance of its AVD that no process has joined yet. Any other process is an instance of its own.

A request names an AVD (`name || id`). A record holds the AVD name, plus the adb serial once the port is allocated. A record joins at most one native instance, and each instance takes at most one record: the instance with the record's serial, or, for a record without a serial, an instance of its AVD. A record that joins no instance counts on its own [observed: `recordMatchesDevice` and `countWorkloads` in `src/server/boot-admission.ts`].

### Reopen

A request for a workload that already counts (the same UDID on iOS; the same AVD name, or a request `id` equal to a counted serial, on Android) is admitted without a record or a slot. The existing boot behavior then runs unchanged. A create is a new workload, unless its Android AVD name is already counted [observed: `matchesRequest` in `src/server/boot-admission.ts`]. For Android, the reopen is idempotent only at admission; see [Limitations](#limitations).

### Rollback

The admitted attempt's record is deleted at once only when the attempt provably started nothing: port allocation failed, the create failed, or the emulator could not be spawned. After an emulator process was spawned, every outcome (online, exited, wait failed, wait gave up) only marks the record finished. An emulator that did not come online may still be running. A failed `simctl boot` is equally uncertain, so iOS also only marks the record finished [observed: `bootAndroidHubDevice`, `bootHubDevice` and `createHubDevice` in `src/server/device-actions.ts`].

### Absence

A later admission deletes a record only when its device is confirmed gone. The attempt must be over (finished, or its Hub process is not [running](#process-identity)), and:

- **iOS:** its UDID is not a non-`Shutdown` simulator. A record without a UDID (a create that never got one) is gone once the attempt is over.
- **Android:** its emulator process is not running (or was never recorded), and no native instance has its serial. A record without a serial or without an emulator pid also needs no native instance of its AVD, because missing data cannot prove that nothing was spawned.

So a Hub that dies before spawning frees its slot. A Hub that dies after spawning, even before it recorded the emulator's pid, keeps the slot while the emulator process runs or adb lists it. serve-emu's `api/avds/start` records no pid, and no serial when the start failed, so its attempt keeps the slot while any emulator of its AVD runs. An ordinary agent session close changes nothing: the device keeps its slot until it is shut down. There is no TTL, reaper or daemon [observed: `isGone` in `src/server/boot-admission.ts`].

Each admission reads in this order: the records, then the process table, then `simctl` and `adb` [observed: `decide` in `src/server/boot-admission.ts`]. A record read as in progress counts, even if its boot finishes before the devices are read. A record read as over is judged against a process table and device listing taken after it ended, so a boot that finishes during the admission cannot be judged against a listing from before it [observed: test "a boot that finishes between the record load and the device read keeps its slot" in `src/server/__tests__/boot-admission-policy.test.ts`].

### Process identity

A process is its pid plus its start time, both from the process table, so a dead process whose pid was reused is not mistaken for a live one. Records store `hubPid` and `hubStarted`, plus `workloadPid` and `workloadStarted` for the spawned emulator. A process is running when the table has its pid with a start time within 2 seconds of the stored one, and not in the zombie state `Z`: a process that exited but was not reaped by its parent keeps its pid and start time [observed: `isRunning` in `src/server/process-table.ts`]. Linux `ps` derives start times from a boot time it rounds to whole seconds from the wall clock, so one process can read a second apart between calls [inferred: from how procps derives `lstart` from the boot time in `/proc/stat`]. `ps` runs with `LC_ALL=C` and `TZ=UTC0`, so every Hub reads the same start time [observed: `readProcessTable` in `src/server/process-table.ts`]. A Hub reads its own start time once [observed: `self` in `src/server/boot-admission.ts`].

A record without `hubStarted`, such as one written before start times were kept, is unreadable and counts until someone deletes it. When `ps` did not list the emulator right after the spawn, `workloadStarted` is missing and the pid alone decides, which can only over-count [observed: `parseRecord` and `recordTicket` in `src/server/boot-admission.ts`].

### Lock

Admission is one short transaction under a lock file, `boot-admission/lock`, shared by all Hub processes of the account [observed: `acquireLock` in `src/server/boot-admission.ts`]:

1. Write `{pid, started, token}` to a temp file and hard-link it to `lock`. The link fails if the lock exists, and the lock is never half-written.
2. If the holder is [running](#process-identity), retry with a backoff of up to 250 ms. If it is not (its pid is gone, now belongs to another process, or is a zombie), or the file is unreadable, delete the lock and retry. A pid that `kill(pid, 0)` finds unused is gone without a process-table read; otherwise each check reads the table again. When the table cannot be read, admission refuses the boot instead of waiting on.
3. Holding the lock: load records, read the process table and native devices, delete confirmed-gone records, then decide.
4. On admission, write the record, then check that `lock` still holds this token. If not, delete the record and run the admission again.
5. Release: delete `lock` only while it holds this token.

Two processes can judge the same dead holder. The slower one then deletes a live holder's newer lock. Step 4 makes that safe: a token is never written back once its lock is gone, so if the token is still in `lock`, no other process held the lock in between. A holder that lost its lock withdraws instead of committing [inferred: the reasoning behind the protocol; no concurrency stress test exercises it beyond the replaced-lock case in `boot-admission-policy.test.ts`].

An earlier draft of this protocol restored a lock it had moved by mistake. A restored token could reappear after a third process had held and released the lock, letting two holders commit, so the lock is never restored [inferred].

There is no overall timeout of its own. A holder waits only for the native listings, whose commands each stop after 30 seconds [observed: `execSimctl`'s default in `packages/@expo/hub-apple-utils/src/simctl.ts`; `LIST_ADB_DEVICES_TIMEOUT_MS` in `packages/@expo/hub-android-utils/src/list-adb-devices.ts`; `READ_PROCESS_TABLE_TIMEOUT_MS` in `src/server/process-table.ts`]. A holder that crashed is reaped once the process table no longer shows its pid with its start time, even if another process now has the pid.

## Options considered

- **A session-lease ledger in T3**, counting devices per agent session. Rejected: sessions close while their devices keep running, and T3 boots before a session exists. The OS already knows what is booted [inferred].
- **A lease daemon or TTL reaper.** Rejected: another process to run and keep alive, and a TTL guesses when a device is gone instead of checking [inferred].
- **Native occupancy plus boot-attempt records (chosen).** The OS reports what is booted. A record covers only the gap the OS cannot see: before the device appears natively, and an emulator still starting or stuck.

## Consequences

- Hosts without the file behave exactly as before.
- With a policy, each boot runs one extra device listing and a few `ps` listings, under a lock that serializes boots across the account's Hubs.
- Two Hubs admitted at the same time for different AVDs can still pick the same emulator port. Admission does not change port allocation.

## Limitations

- **An Android reopen still spawns.** A reopen of a counted AVD is idempotent only at admission. The Hub's boot then spawns a second `emulator -avd` for it, as it did before. The emulator's AVD lock normally makes the second instance exit at once. With `-read-only` in `EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS`, a second instance of the AVD can run. It takes its own slot from its process, but it was admitted without one, so the host can run one emulator over the limit [inferred: from the emulator's AVD lock and its `-read-only` flag; `buildEmulatorArgs` in `packages/@expo/hub-android-utils/src/emulator.ts` appends the variable].
- **Command Line Tools only.** On a Mac with only the Command Line Tools, `xcrun simctl` fails without `ENOENT`. Occupancy is then unknown, and a host with a policy refuses every boot, Android ones included. This fails closed on purpose: install Xcode or remove the policy [inferred: from `isMissingTool` in `src/server/boot-admission.ts`].
- **A wall-clock step on Linux.** Linux `ps` start times move with the wall clock. After a step of more than 2 seconds, every process looks replaced. A lock is then reaped from a live holder, which withdraws safely, and an attempt still in progress is judged as if its Hub had died: it keeps its slot only while its device is visible, so an attempt that has not spawned yet frees its slot early [inferred: from how procps derives `lstart` from the boot time in `/proc/stat`].
- **Emulator processes are recognized by their command line.** A process counts only when its program is `emulator` or `qemu-system-*` and it names an AVD. A wrapper that renames the binary, or hides the AVD from its arguments, is not seen until adb lists it [observed: `parseEmulatorArgs` in `packages/@expo/hub-android-utils/src/emulator.ts`].
