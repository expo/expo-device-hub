/**
 * Virtual-device boot admission against a host capacity policy.
 *
 * Several Hub processes can run under one OS account (one per T3 namespace or
 * environment) and each boots devices on request. A host-owned policy file
 * caps how many simulators and emulators may be booted or starting at once,
 * across all of them. Without the file, admission does nothing.
 *
 * Occupancy is what the OS reports (`simctl`, `adb`, emulator processes in
 * `ps`) plus a small record per boot attempt, which covers the time before a
 * device shows up natively and an emulator that is still starting or never
 * came online.
 *
 * @ref LLP 0018#contract — what counts, what frees a slot, and why
 */

import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";

import {
  type AndroidUtilsError,
  type EmulatorProcess,
  emulatorSerial,
  isEmulatorSerial,
  listAdbDevices,
  parseEmulatorArgs,
} from "@expo/hub-android-utils";
import { type AppleUtilsError, listDeviceStates } from "@expo/hub-apple-utils";

import { type HubDevicePlatform } from "./devices";
import {
  type HostProcess,
  type ProcessIdentity,
  type ProcessTableResult,
  isRunning,
  pidExists,
  readProcessTable,
} from "./process-table";
import { type SerializableError, toSerializableError } from "./utility-errors";

export interface NativeSimulator {
  udid: string;
  name: string;
  /** simctl state: `Shutdown`, `Booting`, `Booted`, `Shutting Down`, … */
  state: string;
}

export interface NativeAndroidDevice {
  /** adb serial; only `emulator-<port>` serials count. */
  serial: string;
  /** adb state: `device`, `offline`, `unauthorized`, … */
  state: string;
  /** AVD name of an online emulator, when adb reported it. */
  avdName: string | null;
}

/** Every simulator and every adb device the host reports, in any state. */
export interface NativeOccupancy {
  simulators: NativeSimulator[];
  androidDevices: NativeAndroidDevice[];
}

export interface OccupancyResult {
  value: NativeOccupancy | null;
  error: SerializableError | null;
}

/** The OS facts admission depends on; tests substitute a fake host. */
export interface BootAdmissionHost {
  /**
   * List the native devices. A platform whose tool is not installed lists
   * nothing; any other failure is an `error`, which refuses the boot.
   */
  readOccupancy(): Promise<OccupancyResult>;
  /**
   * List this OS account's processes. Any failure is an `error`, which
   * refuses the boot: without the table, liveness is unknown.
   */
  readProcesses(): Promise<ProcessTableResult>;
  /** Whether any process has `pid`, so a dead lock holder needs no table read. */
  pidExists(pid: number): boolean;
}

/** The workload a boot or create request would start. */
export type AdmissionRequest =
  | {
      platform: "ios";
      /** `null` for a simulator that is still to be created. */
      udid: string | null;
      /** Shown in a refusal. */
      name: string;
    }
  | {
      platform: "android";
      avdName: string;
      /** The request id, which names a running emulator's adb serial on a reopen. */
      serial: string | null;
      name: string;
    };

/**
 * The admitted attempt's lifecycle. Each step updates the attempt record, so
 * a later admission can tell a starting device from one that is gone.
 */
export interface BootTicket {
  /** The UDID of a simulator created after admission. */
  identify(udid: string): Promise<void>;
  /** The adb serial allocated for the emulator, before it is spawned. */
  reserveSerial(serial: string): Promise<void>;
  /** The emulator process was spawned. */
  spawned(pid: number | null): Promise<void>;
  /**
   * Free the slot of an attempt that provably started nothing: port
   * allocation, create, or spawn failed without a process.
   */
  rollback(): Promise<void>;
  /**
   * The boot step returned, successfully or not. The record stays until a
   * later admission confirms the device is gone.
   */
  finish(): Promise<void>;
}

export type AdmissionResult =
  | { ok: true; ticket: BootTicket }
  | { ok: false; error: string; errors: SerializableError[] };

export interface BootAdmission {
  /**
   * Whether a policy file exists, valid or not. Callers that must parse a
   * request to admit it skip that work, and leave the request untouched,
   * when it does not.
   */
  constrained(): Promise<boolean>;
  admit(request: AdmissionRequest): Promise<AdmissionResult>;
}

export interface BootAdmissionOptions {
  /** `{"maxVirtualDevices": <integer >= 0>}`; when absent, boots are unconstrained. */
  policyFile: string;
  /** Holds the admission lock and the attempt records. */
  stateDir: string;
  host: BootAdmissionHost;
}

/** One attempt record, `attempt-<pid>-<random>.json` in the state directory. */
interface AttemptRecord {
  version: 1;
  platform: HubDevicePlatform;
  udid?: string;
  avdName?: string;
  serial?: string;
  /** The Hub process that made the attempt, with its start time. */
  hubPid: number;
  hubStarted: number;
  /** The emulator process, once spawned. */
  workloadPid?: number;
  /** Its start time, when `ps` listed it after the spawn; without one, the pid alone counts. */
  workloadStarted?: number;
  finished: boolean;
  createdAt: string;
}

interface LoadedRecord {
  path: string;
  /** `null` for a record that could not be read, which counts as one device. */
  record: AttemptRecord | null;
}

/** One counted device: native, a record, or a native device a record joined. */
interface Workload {
  platform: HubDevicePlatform;
  udid?: string;
  avdName?: string;
  serial?: string;
  /** Only an unfinished attempt shows it so far. */
  starting: boolean;
  /** Set for a record that could not be read, which counts as one device. */
  unreadable?: string;
}

interface LockOwner extends ProcessIdentity {
  token: string;
}

const RECORD_PATTERN = /^attempt-.*\.json$/;
const LOCK_FILE = "lock";
const LOCK_RETRY_MAX_MS = 250;

const NO_OP_TICKET: BootTicket = {
  identify: async () => {},
  reserveSerial: async () => {},
  spawned: async () => {},
  rollback: async () => {},
  finish: async () => {},
};

/**
 * The policy file and state directory for this OS account.
 *
 * The home comes from the passwd entry, not `$HOME`: Hub processes started
 * with a per-environment `HOME` must still find, and cannot move, the
 * account's one policy.
 *
 * @ref LLP 0018#host-policy — host-owned, no override
 */
export function defaultBootAdmissionPaths(): { policyFile: string; stateDir: string } {
  const base = join(userInfo().homedir, ".expo", "device-hub");
  return {
    policyFile: join(base, "host-policy.json"),
    stateDir: join(base, "boot-admission"),
  };
}

const nativeHost: BootAdmissionHost = {
  async readOccupancy() {
    const [simulators, adb] = await Promise.all([listDeviceStates(), listAdbDevices()]);
    for (const listed of [simulators, adb]) {
      if (listed.error && !isMissingTool(listed.error)) {
        return { value: null, error: toSerializableError(listed.error) };
      }
    }
    return {
      value: {
        simulators: simulators.error
          ? []
          : simulators.value.map(({ udid, name, state }) => ({ udid, name, state })),
        androidDevices: adb.error ? [] : adb.value,
      },
      error: null,
    };
  },
  readProcesses: readProcessTable,
  pidExists,
};

/** This Hub process's identity, read once per host. */
const selves = new WeakMap<BootAdmissionHost, Promise<ProcessIdentity>>();

/** A platform whose tool (`xcrun`, `adb`) is not installed has no devices. */
function isMissingTool(error: AppleUtilsError | AndroidUtilsError): boolean {
  return errorCode(error.error) === "ENOENT";
}

/**
 * Admission for this OS account's policy, resolved on every boot. An account
 * without a passwd home has nowhere to keep a policy, so it is unconstrained.
 */
export const defaultBootAdmission: BootAdmission = {
  async constrained() {
    return (await accountAdmission()?.constrained()) ?? false;
  },
  async admit(request) {
    return (await accountAdmission()?.admit(request)) ?? { ok: true, ticket: NO_OP_TICKET };
  },
};

function accountAdmission(): BootAdmission | null {
  try {
    return createBootAdmission({ ...defaultBootAdmissionPaths(), host: nativeHost });
  } catch {
    return null;
  }
}

export function createBootAdmission({
  policyFile,
  stateDir,
  host,
}: BootAdmissionOptions): BootAdmission {
  const lockPath = join(stateDir, LOCK_FILE);

  return {
    async constrained() {
      return (await readPolicy(policyFile)).kind !== "none";
    },
    async admit(request) {
      const policy = await readPolicy(policyFile);
      if (policy.kind === "none") return { ok: true, ticket: NO_OP_TICKET };
      if (policy.kind === "invalid") return refusal(policy.error);

      try {
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        return await admitUnderLock(request, policy.maxVirtualDevices);
      } catch (error) {
        return refusal(`Device host capacity could not be checked: ${errorMessage(error)}`);
      }
    },
  };

  /**
   * The admission transaction. A record is the commitment, so it is written
   * while the lock is held and only kept when the lock was still ours after
   * the write. See {@link acquireLock}.
   */
  async function admitUnderLock(
    request: AdmissionRequest,
    maxVirtualDevices: number,
  ): Promise<AdmissionResult> {
    for (;;) {
      const owner = await acquireLock();
      try {
        const decision = await decide(request, maxVirtualDevices, owner);
        if (decision.kind === "refused") return refusal(decision.error, decision.errors);
        if (decision.kind === "counted") return { ok: true, ticket: NO_OP_TICKET };

        const path = join(stateDir, `attempt-${process.pid}-${randomUUID()}.json`);
        await writeJsonAtomic(path, decision.record);
        if (await holdsLock(owner))
          return { ok: true, ticket: recordTicket(path, decision.record, host) };

        // Another process took the lock while this one decided; withdraw and admit again.
        await removeFile(path);
      } finally {
        await releaseLock(owner);
      }
    }
  }

  /**
   * The records are loaded before anything native is read, and the process
   * table before the devices. A record loaded as in progress counts even if
   * it finishes meanwhile, and a record loaded as over (finished, or its Hub
   * dead) is judged against a snapshot taken after it ended.
   *
   * @ref LLP 0018#absence — why the records are read first
   */
  async function decide(
    request: AdmissionRequest,
    maxVirtualDevices: number,
    owner: ProcessIdentity,
  ): Promise<
    | { kind: "refused"; error: string; errors: SerializableError[] }
    | { kind: "counted" }
    | { kind: "admit"; record: AttemptRecord }
  > {
    const records = await loadRecords();
    const processes = await listProcesses();
    const occupancy = await host.readOccupancy();
    if (occupancy.error || !occupancy.value) {
      return {
        kind: "refused",
        error:
          "Device host capacity could not be checked: the booted virtual devices on this host could not be read.",
        errors: occupancy.error ? [occupancy.error] : [],
      };
    }

    const workloads = await countWorkloads(records, occupancy.value, processes);
    if (workloads.some((workload) => matchesRequest(workload, request))) return { kind: "counted" };

    if (workloads.length >= maxVirtualDevices) {
      return {
        kind: "refused",
        error: capacityMessage(workloads, maxVirtualDevices, request.name),
        errors: [],
      };
    }

    return {
      kind: "admit",
      record: {
        version: 1,
        platform: request.platform,
        ...(request.platform === "ios"
          ? request.udid
            ? { udid: request.udid }
            : {}
          : { avdName: request.avdName }),
        hubPid: owner.pid,
        hubStarted: owner.started,
        finished: false,
        createdAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Every native device counts on its own. A record joins at most one native
   * device that shows it, and otherwise counts on its own, until its device is
   * confirmed gone; then the record is deleted.
   */
  async function countWorkloads(
    records: LoadedRecord[],
    occupancy: NativeOccupancy,
    processes: HostProcess[],
  ): Promise<Workload[]> {
    const native = nativeWorkloads(occupancy, processes);
    const workloads = [...native];
    const joined = new Set<Workload>();

    for (const { path, record } of records) {
      if (!record) {
        workloads.push({ platform: "ios", starting: false, unreadable: path });
        continue;
      }
      const inProgress =
        !record.finished &&
        isRunning(processes, { pid: record.hubPid, started: record.hubStarted });
      if (!inProgress && isGone(record, native, processes)) {
        await removeFile(path);
        continue;
      }

      const device = native.find(
        (workload) => !joined.has(workload) && recordMatchesDevice(record, workload),
      );
      if (device) {
        joined.add(device);
        device.avdName ??= record.avdName;
        continue;
      }
      workloads.push({
        platform: record.platform,
        udid: record.udid,
        avdName: record.avdName,
        serial: record.serial,
        starting: inProgress,
      });
    }
    return workloads;
  }

  async function loadRecords(): Promise<LoadedRecord[]> {
    const names = (await readdir(stateDir)).filter((name) => RECORD_PATTERN.test(name));
    const records: LoadedRecord[] = [];
    for (const name of names) {
      const path = join(stateDir, name);
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        // Deleted by its owner's rollback since the listing.
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      records.push({ path, record: parseRecord(text) });
    }
    return records;
  }

  /**
   * Take the admission lock.
   *
   * Protocol (one OS account, many processes):
   * - The lock is `<stateDir>/lock`, holding `{pid, started, token}`. It is
   *   created by hard-linking a fully written temp file, so it never exists
   *   half-written.
   * - When the lock exists and its holder is running (its pid with its start
   *   time), wait with a short backoff. The lock covers only the admission
   *   transaction: a few native listings and small file operations.
   * - When the holder is gone, its pid reused by another process, or the file
   *   is unreadable, delete the lock and try again. Two processes can judge
   *   the same dead holder, so the second delete can remove a live holder's
   *   newer lock.
   * - That is safe because the holder checks, after writing its record, that
   *   the lock still holds its token. A token is never written back once its
   *   lock is deleted, so a match proves no other process held the lock since
   *   this one took it. On a mismatch the holder deletes its record and runs
   *   the admission again.
   * - Release deletes the lock only while it holds this owner's token.
   * - A holder whose pid no process has is gone without a table read.
   * - A process table that cannot be read throws, which refuses the boot.
   *
   * @ref LLP 0018#lock — why a deleted lock is never restored
   */
  async function acquireLock(): Promise<LockOwner> {
    const owner = { ...(await self()), token: randomUUID() };
    const temp = join(stateDir, `lock-${owner.pid}-${owner.token}.tmp`);
    await writeFile(temp, JSON.stringify(owner), { mode: 0o600 });
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await link(temp, lockPath);
          return owner;
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }

        const holder = await readLockOwner();
        if (holder === "missing") continue;
        if (
          holder === "unreadable" ||
          !host.pidExists(holder.pid) ||
          !isRunning(await listProcesses(), holder)
        ) {
          await removeFile(lockPath);
          continue;
        }
        await delay(Math.min(10 * 2 ** attempt, LOCK_RETRY_MAX_MS));
      }
    } finally {
      await removeFile(temp);
    }
  }

  /** Cached per host; a failed read is not cached, so the next admission tries again. */
  function self(): Promise<ProcessIdentity> {
    let identity = selves.get(host);
    if (!identity) {
      identity = listProcesses().then((processes) => {
        const entry = processes.find(({ pid }) => pid === process.pid);
        if (!entry) throw new Error("this Hub process is missing from its process list.");
        return { pid: entry.pid, started: entry.started };
      });
      identity.catch(() => {
        if (selves.get(host) === identity) selves.delete(host);
      });
      selves.set(host, identity);
    }
    return identity;
  }

  /** Throws when the table cannot be read, which refuses the boot. */
  async function listProcesses(): Promise<HostProcess[]> {
    const listed = await host.readProcesses();
    if (!listed.value) {
      throw new Error(
        `the processes on this host could not be read: ${listed.error?.message ?? "no result"}`,
      );
    }
    return listed.value;
  }

  async function readLockOwner(): Promise<LockOwner | "missing" | "unreadable"> {
    let text: string;
    try {
      text = await readFile(lockPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "missing";
      throw error;
    }
    try {
      const data: unknown = JSON.parse(text);
      if (
        isObject(data) &&
        isPid(data.pid) &&
        isStartTime(data.started) &&
        typeof data.token === "string"
      ) {
        return { pid: data.pid, started: data.started, token: data.token };
      }
    } catch {
      // Unreadable.
    }
    return "unreadable";
  }

  async function holdsLock(owner: LockOwner): Promise<boolean> {
    const holder = await readLockOwner();
    return typeof holder === "object" && holder.token === owner.token;
  }

  /**
   * Never throws, so it cannot replace the transaction's result. A lock that
   * could not be removed is reaped once this process is gone.
   */
  async function releaseLock(owner: LockOwner): Promise<void> {
    try {
      if (await holdsLock(owner)) await removeFile(lockPath);
    } catch (error) {
      console.warn("[expo-device-hub] Failed to release the boot admission lock:", error);
    }
  }
}

type Policy =
  | { kind: "none" }
  | { kind: "limit"; maxVirtualDevices: number }
  | { kind: "invalid"; error: string };

/**
 * Read the policy on every admission, so a change applies to the next boot.
 * Only a missing file means unconstrained; anything else wrong fails closed.
 */
async function readPolicy(policyFile: string): Promise<Policy> {
  let text: string;
  try {
    text = await readFile(policyFile, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "none" };
    return {
      kind: "invalid",
      error: `Could not read the device host policy ${policyFile}: ${errorMessage(error)}`,
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return {
      kind: "invalid",
      error: `Device host policy ${policyFile} is not valid JSON: ${errorMessage(error)}`,
    };
  }

  const max = isObject(data) ? data.maxVirtualDevices : undefined;
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 0) {
    return {
      kind: "invalid",
      error: `Device host policy ${policyFile} is invalid: maxVirtualDevices must be an integer of 0 or more.`,
    };
  }
  return { kind: "limit", maxVirtualDevices: max };
}

/**
 * A record without a start time for its Hub, such as one from before start
 * times were kept, is unreadable: it counts until someone deletes it.
 */
function parseRecord(text: string): AttemptRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isObject(data) ||
    data.version !== 1 ||
    (data.platform !== "ios" && data.platform !== "android") ||
    !isPid(data.hubPid) ||
    !isStartTime(data.hubStarted) ||
    typeof data.finished !== "boolean"
  ) {
    return null;
  }

  const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);
  return {
    version: 1,
    platform: data.platform,
    udid: optionalString(data.udid),
    avdName: optionalString(data.avdName),
    serial: optionalString(data.serial),
    hubPid: data.hubPid,
    hubStarted: data.hubStarted,
    workloadPid: isPid(data.workloadPid) ? data.workloadPid : undefined,
    workloadStarted: isStartTime(data.workloadStarted) ? data.workloadStarted : undefined,
    finished: data.finished,
    createdAt: optionalString(data.createdAt) ?? "",
  };
}

/** Update the record in place; a failed update leaves the earlier one, which still counts. */
function recordTicket(path: string, initial: AttemptRecord, host: BootAdmissionHost): BootTicket {
  let record = initial;
  let closed = false;

  async function update(change: Partial<AttemptRecord>): Promise<void> {
    if (closed) return;
    record = { ...record, ...change };
    try {
      await writeJsonAtomic(path, record);
    } catch (error) {
      console.warn("[expo-device-hub] Failed to update a boot admission record:", error);
    }
  }

  return {
    identify: (udid) => update({ udid }),
    reserveSerial: (serial) => update({ serial }),
    async spawned(pid) {
      if (pid === null) return;
      const listed = await host.readProcesses();
      const started = listed.value?.find((entry) => entry.pid === pid)?.started;
      await update({ workloadPid: pid, workloadStarted: started });
    },
    async rollback() {
      if (closed) return;
      closed = true;
      await removeFile(path).catch((error: unknown) => {
        console.warn("[expo-device-hub] Failed to remove a boot admission record:", error);
      });
    },
    async finish() {
      await update({ finished: true });
      closed = true;
    },
  };
}

/**
 * Whether the device of a record that is no longer in progress is confirmed
 * gone. Missing data never confirms it: an Android record without a serial
 * or an emulator pid may have started any emulator of its AVD.
 *
 * @ref LLP 0018#absence — when a record is deleted
 */
function isGone(record: AttemptRecord, native: Workload[], processes: HostProcess[]): boolean {
  if (record.platform === "ios") {
    return !native.some(
      (device) => device.platform === "ios" && sameUdid(device.udid, record.udid),
    );
  }
  if (
    record.workloadPid !== undefined &&
    isRunning(processes, { pid: record.workloadPid, started: record.workloadStarted })
  ) {
    return false;
  }
  const emulators = native.filter((device) => device.platform === "android");
  if (record.serial !== undefined && emulators.some((device) => device.serial === record.serial)) {
    return false;
  }
  const knowsItsEmulator = record.serial !== undefined && record.workloadPid !== undefined;
  return knowsItsEmulator || !emulators.some((device) => device.avdName === record.avdName);
}

/**
 * Whether a native device is the one a record started: the same UDID, or the
 * same adb serial; a record without a serial joins an emulator of its AVD.
 *
 * @ref LLP 0018#android-identity — a record joins one native device; native devices never merge
 */
function recordMatchesDevice(record: AttemptRecord, device: Workload): boolean {
  if (device.platform !== record.platform) return false;
  if (record.platform === "ios") return sameUdid(device.udid, record.udid);
  return record.serial !== undefined
    ? device.serial === record.serial
    : record.avdName !== undefined && device.avdName === record.avdName;
}

/**
 * The simulators that are not shut down, and each emulator instance: every
 * adb `emulator-<port>` serial, plus every emulator process adb does not list
 * (yet). Physical devices are outside the virtual-device budget.
 *
 * An emulator process with `-port <P>` is the instance adb lists as
 * `emulator-<P>`. A process without a port joins an adb emulator of its AVD
 * that no process has joined yet. Two instances never merge by AVD name.
 *
 * @ref LLP 0018#android-identity — every emulator instance counts on its own
 */
function nativeWorkloads(occupancy: NativeOccupancy, processes: HostProcess[]): Workload[] {
  const simulators = occupancy.simulators
    .filter((simulator) => simulator.state !== "Shutdown")
    .map((simulator): Workload => ({ platform: "ios", udid: simulator.udid, starting: false }));

  const emulators: { workload: Workload; hasProcess: boolean }[] = occupancy.androidDevices
    .filter((device) => isEmulatorSerial(device.serial))
    .map((device) => ({
      workload: {
        platform: "android",
        serial: device.serial,
        avdName: device.avdName ?? undefined,
        starting: false,
      },
      hasProcess: false,
    }));
  for (const { avdName, port } of emulatorProcesses(processes)) {
    const serial = port === null ? undefined : emulatorSerial(port);
    const listed = emulators.find(
      ({ workload, hasProcess }) =>
        !hasProcess &&
        (serial === undefined
          ? workload.avdName === avdName
          : workload.serial === serial && (workload.avdName ?? avdName) === avdName),
    );
    if (listed) {
      listed.hasProcess = true;
      listed.workload.avdName ??= avdName;
      continue;
    }
    emulators.push({
      workload: { platform: "android", serial, avdName, starting: false },
      hasProcess: true,
    });
  }
  return [...simulators, ...emulators.map(({ workload }) => workload)];
}

/**
 * The emulator instances in the process table, by AVD (`-avd <name>` or
 * `@<name>`) and console port. Processes are one instance only on evidence:
 * the same AVD on the same console port, or a child process of an emulator
 * process for the same AVD (by parent pid) whose ports do not differ. Two
 * portless processes of one AVD, such as `-read-only` instances, stay two.
 * Ported instances come first, so they join their adb serials before portless
 * ones join by AVD name.
 *
 * @ref LLP 0018#android-identity — processes merge only on port or parentage
 */
function emulatorProcesses(processes: HostProcess[]): EmulatorProcess[] {
  const emulators = new Map<number, EmulatorProcess & { ppid: number }>();
  for (const { pid, ppid, args } of processes) {
    const emulator = parseEmulatorArgs(args);
    if (emulator) emulators.set(pid, { ...emulator, ppid });
  }

  // Union-find over pids; `link` points each merged pid toward its group's representative.
  const link = new Map<number, number>();
  const find = (pid: number): number => {
    const next = link.get(pid) ?? pid;
    if (next === pid) return pid;
    const top = find(next);
    link.set(pid, top);
    return top;
  };
  const union = (a: number, b: number) => {
    const [rootA, rootB] = [find(a), find(b)];
    if (rootA !== rootB) link.set(rootA, rootB);
  };

  const byPort = new Map<string, number>();
  for (const [pid, emulator] of emulators) {
    const launcher = emulators.get(emulator.ppid);
    if (
      launcher?.avdName === emulator.avdName &&
      (launcher.port === null || emulator.port === null || launcher.port === emulator.port)
    ) {
      union(pid, emulator.ppid);
    }
    if (emulator.port !== null) {
      const key = `${emulator.avdName}\n${emulator.port}`;
      const other = byPort.get(key);
      if (other === undefined) byPort.set(key, pid);
      else union(pid, other);
    }
  }

  const instances = new Map<number, EmulatorProcess>();
  for (const [pid, { avdName, port }] of emulators) {
    const key = find(pid);
    const instance = instances.get(key);
    if (instance) instance.port ??= port;
    else instances.set(key, { avdName, port });
  }
  return [...instances.values()].sort((a, b) => Number(a.port === null) - Number(b.port === null));
}

function matchesRequest(workload: Workload, request: AdmissionRequest): boolean {
  if (workload.unreadable || workload.platform !== request.platform) return false;
  if (request.platform === "ios") return sameUdid(workload.udid, request.udid ?? undefined);
  return (
    workload.avdName === request.avdName ||
    (request.serial !== null && workload.serial === request.serial)
  );
}

function sameUdid(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toUpperCase() === b.toUpperCase();
}

/** Plain refusal text: T3 shows it, and classifies some words, such as timeouts, on its own. */
function capacityMessage(workloads: Workload[], maxVirtualDevices: number, name: string): string {
  if (maxVirtualDevices === 0) {
    return `Device host capacity reached: this host's policy allows 0 virtual devices, so ${name} cannot boot.`;
  }
  return (
    `Device host capacity reached: ${workloads.length} of ${maxVirtualDevices} virtual devices are booted or starting on this host. ` +
    `Shut one down before booting ${name}.` +
    workloads.map((workload) => `\n- ${describeWorkload(workload)}`).join("")
  );
}

function describeWorkload(workload: Workload): string {
  if (workload.unreadable) return `unreadable boot record ${workload.unreadable}`;
  const device =
    workload.platform === "ios"
      ? `iOS simulator ${workload.udid ?? "being created"}`
      : workload.avdName && workload.serial
        ? `Android emulator ${workload.avdName} on ${workload.serial}`
        : `Android emulator ${workload.avdName ?? workload.serial}`;
  return workload.starting ? `${device} (starting)` : device;
}

function refusal(error: string, errors: SerializableError[] = []): AdmissionResult {
  return { ok: false, error, errors };
}

/** Write via a temp file and rename, so readers see the old or the new record. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}

async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isStartTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function errorCode(error: unknown): unknown {
  return isObject(error) ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
