/// <reference types="bun" />

/**
 * The boot-admission policy in one process: the real lock and attempt records
 * in a scratch directory, with a fake native host. The cross-process boot
 * sequence lives in `boot-admission.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import {
  type AdmissionRequest,
  type BootAdmissionHost,
  type NativeOccupancy,
  createBootAdmission,
  defaultBootAdmissionPaths,
} from "../boot-admission";
import type { ProcessTableResult } from "../process-table";
import {
  FAKE_STARTED,
  type FakeProcess,
  fakeProcessTable,
} from "./fixtures/boot-admission-fake-host";

const X = "11111111-1111-1111-1111-111111111111";
const Y = "22222222-2222-2222-2222-222222222222";
const DEAD_PID = 4_100_999;

let dir: string;
let policyFile: string;
let stateDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boot-admission-policy-"));
  mkdirSync(join(dir, "device-hub"));
  policyFile = join(dir, "device-hub", "host-policy.json");
  stateDir = join(dir, "device-hub", "boot-admission");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePolicy(contents: string | number): void {
  writeFileSync(
    policyFile,
    typeof contents === "number" ? JSON.stringify({ maxVirtualDevices: contents }) : contents,
  );
}

interface FakeHost extends BootAdmissionHost {
  occupancy: NativeOccupancy;
  /** The host's process table by pid; this test process is in it. */
  processes: Map<number, FakeProcess>;
  /** Native device reads. */
  reads: number;
  /** Runs after each native device read has taken its snapshot. */
  afterRead?: () => Promise<void>;
}

function fakeHost(occupancy: Partial<NativeOccupancy> = {}): FakeHost {
  const host: FakeHost = {
    occupancy: { simulators: [], androidDevices: [], ...occupancy },
    processes: new Map([[process.pid, "bun test"]]),
    reads: 0,
    async readOccupancy() {
      host.reads++;
      const snapshot = structuredClone(host.occupancy);
      await host.afterRead?.();
      return { value: snapshot, error: null };
    },
    async readProcesses() {
      return { value: fakeProcessTable(host.processes), error: null };
    },
    pidExists: (pid) => host.processes.has(pid),
  };
  return host;
}

/**
 * Call `intercept` before each process-table read with the read's number,
 * from 1; a result it returns replaces the read.
 */
function onProcessRead(
  host: FakeHost,
  intercept: (read: number) => ProcessTableResult | void,
): void {
  const read = host.readProcesses.bind(host);
  let reads = 0;
  host.readProcesses = async () => intercept(++reads) ?? read();
}

function admission(host: BootAdmissionHost) {
  return createBootAdmission({ policyFile, stateDir, host });
}

function ios(udid: string | null, name = "iPhone"): AdmissionRequest {
  return { platform: "ios", udid, name };
}

function android(avdName: string, serial: string | null = null): AdmissionRequest {
  return { platform: "android", avdName, serial, name: avdName };
}

function attempts(): string[] {
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir).filter((name) => /^attempt-.*\.json$/.test(name));
}

function writeRecord(name: string, record: Record<string, unknown>): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, name),
    JSON.stringify({
      version: 1,
      finished: false,
      hubStarted: FAKE_STARTED,
      createdAt: "2026-11-01T00:00:00.000Z",
      ...record,
    }),
  );
}

describe("host policy", () => {
  test("no policy file admits without a lock, an occupancy read, or a record", async () => {
    const host = fakeHost({ simulators: [{ udid: X, name: "iPhone", state: "Booted" }] });

    const admitted = await admission(host).admit(ios(Y));

    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    await admitted.ticket.finish();
    await admitted.ticket.rollback();
    expect(host.reads).toBe(0);
    expect(existsSync(stateDir)).toBe(false);
  });

  test.each([
    ["is not JSON", "{", "is not valid JSON"],
    ["has no maxVirtualDevices", "{}", "maxVirtualDevices must be an integer of 0 or more"],
    ["is an array", "[1]", "maxVirtualDevices must be an integer of 0 or more"],
    ["has a negative limit", '{"maxVirtualDevices": -1}', "an integer of 0 or more"],
    ["has a fractional limit", '{"maxVirtualDevices": 1.5}', "an integer of 0 or more"],
    ["has a string limit", '{"maxVirtualDevices": "1"}', "an integer of 0 or more"],
  ])("a policy that %s refuses the boot", async (_, contents, problem) => {
    writePolicy(contents);
    const host = fakeHost();

    const refused = await admission(host).admit(ios(X));

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain(policyFile);
    expect(refused.error).toContain(problem);
    expect(host.reads).toBe(0);
    expect(existsSync(stateDir)).toBe(false);
  });

  test("an unreadable policy refuses the boot", async () => {
    mkdirSync(policyFile);

    const refused = await admission(fakeHost()).admit(ios(X));

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain(`Could not read the device host policy ${policyFile}`);
  });

  test("a limit of 0 refuses every boot", async () => {
    writePolicy(0);

    const refused = await admission(fakeHost()).admit(ios(X));

    expect(refused).toMatchObject({ ok: false, errors: [] });
    if (refused.ok) return;
    expect(refused.error).toContain("allows 0 virtual devices");
    expect(attempts()).toEqual([]);
  });

  test("the default paths use the passwd home, not $HOME", () => {
    const home = process.env.HOME;
    process.env.HOME = join(dir, "environment-home");
    try {
      expect(defaultBootAdmissionPaths()).toEqual({
        policyFile: join(userInfo().homedir, ".expo", "device-hub", "host-policy.json"),
        stateDir: join(userInfo().homedir, ".expo", "device-hub", "boot-admission"),
      });
    } finally {
      process.env.HOME = home;
    }
  });
});

describe("occupancy", () => {
  test("an admitted boot writes a record that holds its slot", async () => {
    writePolicy(1);
    const host = fakeHost();

    const admitted = await admission(host).admit(ios(X));
    expect(admitted.ok).toBe(true);
    expect(attempts()).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(stateDir, attempts()[0]!), "utf8"));
    expect(record).toMatchObject({
      version: 1,
      platform: "ios",
      udid: X,
      hubPid: process.pid,
      finished: false,
    });

    const refused = await admission(host).admit(ios(Y, "iPhone Y"));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe(
      "Device host capacity reached: 1 of 1 virtual devices are booted or starting on this host. " +
        `Shut one down before booting iPhone Y.\n- iOS simulator ${X} (starting)`,
    );
  });

  test("a booted simulator without a record takes a slot and is left running", async () => {
    writePolicy(1);
    const host = fakeHost({ simulators: [{ udid: X, name: "iPhone", state: "Booted" }] });

    const refused = await admission(host).admit(ios(Y));

    expect(refused.ok).toBe(false);
    expect(host.occupancy.simulators).toEqual([{ udid: X, name: "iPhone", state: "Booted" }]);
  });

  test.each(["Booting", "Shutting Down"])("a %s simulator takes a slot", async (state) => {
    writePolicy(1);
    const host = fakeHost({ simulators: [{ udid: X, name: "iPhone", state }] });

    expect((await admission(host).admit(ios(Y))).ok).toBe(false);
  });

  test.each(["device", "offline", "unauthorized"])(
    "an emulator in adb state %s takes a slot",
    async (state) => {
      writePolicy(1);
      const host = fakeHost({
        androidDevices: [{ serial: "emulator-5554", state, avdName: null }],
      });

      expect((await admission(host).admit(android("Pixel_9"))).ok).toBe(false);
    },
  );

  test("a physical Android device does not take a slot", async () => {
    writePolicy(1);
    const host = fakeHost({
      androidDevices: [{ serial: "R5CT1234ABC", state: "device", avdName: null }],
    });

    expect((await admission(host).admit(android("Pixel_9"))).ok).toBe(true);
  });

  test("unreadable occupancy refuses the boot", async () => {
    writePolicy(1);
    const host = fakeHost();
    host.readOccupancy = async () => ({
      value: null,
      error: { id: "x", message: "Failed to run `adb devices -l`", error: "Error: adb" },
    });

    const refused = await admission(host).admit(ios(X));

    expect(refused).toMatchObject({
      ok: false,
      error:
        "Device host capacity could not be checked: the booted virtual devices on this host could not be read.",
      errors: [{ message: "Failed to run `adb devices -l`" }],
    });
    expect(attempts()).toEqual([]);
  });

  test("an unreadable process table refuses the boot", async () => {
    writePolicy(1);
    const host = fakeHost();
    host.readProcesses = async () => ({
      value: null,
      error: { id: "ps", message: "Failed to list the host's processes with `ps`", error: "" },
    });

    const refused = await admission(host).admit(ios(X));

    expect(refused).toMatchObject({
      ok: false,
      error:
        "Device host capacity could not be checked: the processes on this host could not be read: " +
        "Failed to list the host's processes with `ps`",
    });
    expect(host.reads).toBe(0);
    expect(attempts()).toEqual([]);
  });

  test("a reopened simulator is admitted without a record, by any UDID case", async () => {
    writePolicy(1);
    const host = fakeHost({ simulators: [{ udid: X, name: "iPhone", state: "Booted" }] });

    const admitted = await admission(host).admit(ios(X.toLowerCase()));

    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    await admitted.ticket.finish();
    expect(attempts()).toEqual([]);
  });
});

describe("Android AVD and serial identity", () => {
  test("a record and its native emulator count as one workload", async () => {
    writePolicy(1);
    const host = fakeHost();
    const admitted = await admission(host).admit(android("Pixel_9"));
    if (!admitted.ok) throw new Error(admitted.error);
    await admitted.ticket.reserveSerial("emulator-5560");
    host.processes.set(4_100_001, "emulator -avd Pixel_9 -port 5560");
    await admitted.ticket.spawned(4_100_001);

    // Offline: adb knows only the serial.
    host.occupancy.androidDevices = [{ serial: "emulator-5560", state: "offline", avdName: null }];
    const whileOffline = await admission(host).admit(android("Pixel_8"));
    expect(!whileOffline.ok && whileOffline.error).toStartWith(
      "Device host capacity reached: 1 of 1",
    );

    // Online: adb also reports the AVD name.
    await admitted.ticket.finish();
    host.occupancy.androidDevices = [
      { serial: "emulator-5560", state: "device", avdName: "Pixel_9" },
    ];
    expect((await admission(host).admit(android("Pixel_9"))).ok).toBe(true);
    expect((await admission(host).admit(android("emulator-5560", "emulator-5560"))).ok).toBe(true);
    expect(attempts()).toHaveLength(1);
    const refused = await admission(host).admit(android("Pixel_8"));
    expect(!refused.ok && refused.error).toBe(
      "Device host capacity reached: 1 of 1 virtual devices are booted or starting on this host. " +
        "Shut one down before booting Pixel_8.\n- Android emulator Pixel_9 on emulator-5560",
    );
  });

  test("a native emulator named by its AVD matches a reopen by name", async () => {
    writePolicy(1);
    const host = fakeHost({
      androidDevices: [{ serial: "emulator-5554", state: "device", avdName: "Pixel_9" }],
    });

    expect((await admission(host).admit(android("Pixel_9"))).ok).toBe(true);
    expect(attempts()).toEqual([]);
  });
});

describe("attempt lifecycle", () => {
  test("rollback frees the slot of an unused attempt", async () => {
    writePolicy(1);
    const host = fakeHost();
    const admitted = await admission(host).admit(android("Pixel_9"));
    if (!admitted.ok) throw new Error(admitted.error);
    await admitted.ticket.reserveSerial("emulator-5560");

    await admitted.ticket.rollback();

    expect(attempts()).toEqual([]);
    expect((await admission(host).admit(android("Pixel_8"))).ok).toBe(true);
  });

  test("a finished attempt counts until its emulator is gone", async () => {
    writePolicy(1);
    const host = fakeHost();
    const admitted = await admission(host).admit(android("Pixel_9"));
    if (!admitted.ok) throw new Error(admitted.error);
    await admitted.ticket.reserveSerial("emulator-5560");
    host.processes.set(4_100_001, "emulator -avd Pixel_9 -port 5560");
    await admitted.ticket.spawned(4_100_001);
    await admitted.ticket.finish();

    expect((await admission(host).admit(android("Pixel_8"))).ok).toBe(false);

    host.processes.delete(4_100_001);
    expect((await admission(host).admit(android("Pixel_8"))).ok).toBe(true);
    expect(attempts()).toHaveLength(1);
  });

  test("an attempt that lost its port to another AVD frees its slot once its emulator exits", async () => {
    writePolicy(2);
    const host = fakeHost();
    // Two Hubs pick port 5560 at once; Pixel_7 wins it.
    for (const [avdName, pid] of [
      ["Pixel_7", 4_100_001],
      ["Pixel_9", 4_100_002],
    ] as const) {
      const admitted = await admission(host).admit(android(avdName));
      if (!admitted.ok) throw new Error(admitted.error);
      await admitted.ticket.reserveSerial("emulator-5560");
      host.processes.set(pid, `emulator -avd ${avdName} -port 5560`);
      await admitted.ticket.spawned(pid);
      await admitted.ticket.finish();
    }
    host.occupancy.androidDevices = [
      { serial: "emulator-5560", state: "device", avdName: "Pixel_7" },
    ];

    expect((await admission(host).admit(android("Pixel_8"))).ok).toBe(false);

    // Pixel_9's Hub stopped its emulator; only Pixel_7 runs.
    host.processes.delete(4_100_002);
    expect((await admission(host).admit(android("Pixel_8"))).ok).toBe(true);
    expect(attempts()).toHaveLength(2);
  });

  test("an unfinished attempt of a dead Hub frees its slot only before spawn", async () => {
    writePolicy(1);
    writeRecord("attempt-1-a.json", {
      platform: "android",
      avdName: "Pixel_7",
      serial: "emulator-5558",
      hubPid: DEAD_PID,
    });
    const host = fakeHost();

    expect((await admission(host).admit(android("Pixel_9"))).ok).toBe(true);
    expect(attempts()).not.toContain("attempt-1-a.json");
  });

  test("an unfinished attempt of a dead Hub counts while its emulator lives", async () => {
    writePolicy(1);
    writeRecord("attempt-1-a.json", {
      platform: "android",
      avdName: "Pixel_7",
      serial: "emulator-5558",
      hubPid: DEAD_PID,
      workloadPid: 4_100_001,
      workloadStarted: FAKE_STARTED,
    });
    const host = fakeHost();
    // The record's serial is not listed, so only the emulator process keeps it.
    host.processes.set(4_100_001, "emulator -avd Pixel_7");

    expect((await admission(host).admit(android("Pixel_9"))).ok).toBe(false);
    expect(attempts()).toEqual(["attempt-1-a.json"]);
  });

  test("an iOS create counts before its UDID is known", async () => {
    writePolicy(1);
    const host = fakeHost();
    const admitted = await admission(host).admit(ios(null, "iPhone Z"));
    if (!admitted.ok) throw new Error(admitted.error);

    expect((await admission(host).admit(ios(Y))).ok).toBe(false);

    // Once created, a boot of its UDID is the same workload.
    await admitted.ticket.identify(X);
    expect((await admission(host).admit(ios(X))).ok).toBe(true);
    expect(attempts()).toHaveLength(1);

    // Finished and not booted natively: confirmed absent, so the slot is free.
    await admitted.ticket.finish();
    expect((await admission(host).admit(ios(Y))).ok).toBe(true);
  });

  test("an unreadable record takes a slot", async () => {
    writePolicy(1);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "attempt-1-a.json"), "{");

    const refused = await admission(fakeHost()).admit(ios(X));

    expect(!refused.ok && refused.error).toContain(
      `unreadable boot record ${join(stateDir, "attempt-1-a.json")}`,
    );
  });
});

describe("admission lock", () => {
  test("a lock left by a dead process is reaped", async () => {
    writePolicy(1);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "lock"),
      JSON.stringify({ pid: DEAD_PID, started: FAKE_STARTED, token: "dead" }),
    );
    const host = fakeHost();
    const reads: number[] = [];
    onProcessRead(host, (read) => {
      reads.push(read);
    });

    expect((await admission(host).admit(ios(X))).ok).toBe(true);
    expect(existsSync(join(stateDir, "lock"))).toBe(false);
    // This Hub's own start time and the admission: no read for the dead holder.
    expect(reads).toEqual([1, 2]);

    // The own start time is read once per host.
    expect((await admission(host).admit(ios(X))).ok).toBe(true);
    expect(reads).toEqual([1, 2, 3]);
  });

  test("a live holder is waited for, not reaped", async () => {
    writePolicy(1);
    mkdirSync(stateDir, { recursive: true });
    const lock = join(stateDir, "lock");
    writeFileSync(lock, JSON.stringify({ pid: 4_100_002, started: FAKE_STARTED, token: "live" }));
    const host = fakeHost();
    host.processes.set(4_100_002, "bun hub");
    let holderSeen!: () => void;
    const seen = new Promise<void>((resolve) => (holderSeen = resolve));
    onProcessRead(host, (read) => {
      // The first read finds this process's own start time; the second checks the holder.
      if (read === 2) holderSeen();
    });

    const admitting = admission(host).admit(ios(X));
    await seen;
    expect(host.reads).toBe(0);
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("live");
    unlinkSync(lock);

    expect((await admitting).ok).toBe(true);
    expect(host.reads).toBe(1);
  });

  test("a holder whose lock was replaced withdraws its record and admits again", async () => {
    writePolicy(1);
    const host = fakeHost();
    const read = host.readOccupancy.bind(host);
    host.readOccupancy = async () => {
      // Another process reaped and replaced this holder's lock mid-transaction.
      if (host.reads === 0) {
        writeFileSync(join(stateDir, "lock"), JSON.stringify({ pid: DEAD_PID, token: "other" }));
      }
      return read();
    };

    const admitted = await admission(host).admit(ios(X));

    expect(admitted.ok).toBe(true);
    expect(host.reads).toBe(2);
    expect(attempts()).toHaveLength(1);
    expect(existsSync(join(stateDir, "lock"))).toBe(false);
  });
});

describe("emulator processes", () => {
  test("a Hub that died after its spawn keeps the slot while the emulator process runs", async () => {
    writePolicy(1);
    // The Hub reserved the serial and spawned, then died before it recorded the pid.
    writeRecord("attempt-1-a.json", {
      platform: "android",
      avdName: "Pixel_9",
      serial: "emulator-5560",
      hubPid: DEAD_PID,
    });
    const host = fakeHost();
    // adb does not list the emulator yet.
    host.processes.set(4_100_001, "/sdk/emulator/emulator -avd Pixel_9 -port 5560");

    const refused = await admission(host).admit(android("Pixel_8"));
    expect(!refused.ok && refused.error).toStartWith("Device host capacity reached: 1 of 1");
    expect(attempts()).toEqual(["attempt-1-a.json"]);

    host.processes.delete(4_100_001);
    expect((await admission(host).admit(android("Pixel_8"))).ok).toBe(true);
    expect(attempts()).not.toContain("attempt-1-a.json");
  });

  test("an emulator process adb does not list takes a slot", async () => {
    writePolicy(1);
    const host = fakeHost();
    host.processes.set(4_100_001, "emulator @Pixel_9 -port 5556");

    const refused = await admission(host).admit(android("Pixel_8"));

    expect(!refused.ok && refused.error).toEndWith("\n- Android emulator Pixel_9 on emulator-5556");
    expect((await admission(host).admit(android("Pixel_9"))).ok).toBe(true);
  });

  test("two adb emulators of one AVD take two slots", async () => {
    writePolicy(2);
    const host = fakeHost({
      androidDevices: [
        { serial: "emulator-5554", state: "device", avdName: "Pixel_9" },
        { serial: "emulator-5556", state: "device", avdName: "Pixel_9" },
      ],
    });

    const refused = await admission(host).admit(android("Pixel_8"));

    expect(!refused.ok && refused.error).toBe(
      "Device host capacity reached: 2 of 2 virtual devices are booted or starting on this host. " +
        "Shut one down before booting Pixel_8.\n" +
        "- Android emulator Pixel_9 on emulator-5554\n" +
        "- Android emulator Pixel_9 on emulator-5556",
    );
    // Either instance makes a boot of Pixel_9 a reopen.
    expect((await admission(host).admit(android("Pixel_9"))).ok).toBe(true);
  });

  test("an emulator's launcher, its qemu child and its adb serial count once", async () => {
    writePolicy(2);
    const host = fakeHost({
      androidDevices: [{ serial: "emulator-5554", state: "offline", avdName: null }],
    });
    host.processes.set(4_100_001, "emulator @Pixel_9 -port 5554");
    host.processes.set(
      4_100_002,
      "/sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64 -avd Pixel_9 -port 5554 -no-window",
    );

    expect((await admission(host).admit(android("Pixel_8"))).ok).toBe(true);
  });

  test("two portless emulators of one AVD take two slots", async () => {
    writePolicy(2);
    const host = fakeHost();
    host.processes.set(4_100_011, "/sdk/qemu-system-aarch64 -avd Pixel_9 -read-only");
    host.processes.set(4_100_012, {
      args: "/sdk/qemu-system-aarch64 -avd Pixel_9 -read-only",
      started: FAKE_STARTED + 60,
    });

    const refused = await admission(host).admit(ios(X));

    expect(!refused.ok && refused.error).toStartWith("Device host capacity reached: 2 of 2");
  });

  test("emulators of different AVDs on one port take two slots", async () => {
    writePolicy(2);
    const host = fakeHost();
    host.processes.set(4_100_031, "/sdk/emulator/emulator -avd Pixel_9 -port 5554");
    host.processes.set(4_100_032, "/sdk/emulator/emulator -avd Pixel_8 -port 5554");

    const refused = await admission(host).admit(ios(X));

    expect(!refused.ok && refused.error).toStartWith("Device host capacity reached: 2 of 2");
  });

  test("a child emulator on a different port than its parent takes its own slot", async () => {
    writePolicy(2);
    const host = fakeHost();
    host.processes.set(4_100_041, "/sdk/emulator/emulator -avd Pixel_9 -port 5554");
    host.processes.set(4_100_042, {
      args: "/sdk/qemu-system-x86_64 -avd Pixel_9 -port 5556",
      ppid: 4_100_041,
    });

    const refused = await admission(host).admit(ios(X));

    expect(!refused.ok && refused.error).toStartWith("Device host capacity reached: 2 of 2");
  });

  test("a portless emulator launcher and its qemu child count once", async () => {
    writePolicy(2);
    const host = fakeHost();
    host.processes.set(4_100_021, "/sdk/emulator/emulator -avd Pixel_9");
    host.processes.set(4_100_022, {
      args: "/sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64 -avd Pixel_9",
      ppid: 4_100_021,
    });

    expect((await admission(host).admit(ios(X))).ok).toBe(true);
  });
});

describe("ordering of records and native reads", () => {
  test("a boot that finishes between the record load and the device read keeps its slot", async () => {
    writePolicy(1);
    const host = fakeHost({ simulators: [{ udid: X, name: "iPhone", state: "Shutdown" }] });
    const admitted = await admission(host).admit(ios(X));
    if (!admitted.ok) throw new Error(admitted.error);

    // B's admission reads Shutdown; X then boots and A finishes its attempt.
    host.afterRead = async () => {
      host.afterRead = undefined;
      host.occupancy.simulators[0]!.state = "Booted";
      await admitted.ticket.finish();
    };
    const refused = await admission(host).admit(ios(Y));

    expect(!refused.ok && refused.error).toStartWith("Device host capacity reached: 1 of 1");
    expect(attempts()).toHaveLength(1);
    expect((await admission(host).admit(ios(Y))).ok).toBe(false);
  });
});

describe("process identity", () => {
  test("a record whose Hub pid now belongs to another process is over", async () => {
    writePolicy(1);
    writeRecord("attempt-1-a.json", {
      platform: "android",
      avdName: "Pixel_7",
      hubPid: 4_100_004,
      hubStarted: FAKE_STARTED - 600,
    });
    const host = fakeHost();
    host.processes.set(4_100_004, "unrelated");

    expect((await admission(host).admit(android("Pixel_9"))).ok).toBe(true);
    expect(attempts()).not.toContain("attempt-1-a.json");
  });

  /**
   * Admit `request` while a lock is in place, and report whether the admission
   * settled or kept waiting on the lock's holder. A process-table read while
   * the lock still holds `token` is one holder check; a third means the holder
   * is being waited for again.
   */
  async function admitPastLock(host: FakeHost, token: string, request: AdmissionRequest) {
    const lock = join(stateDir, "lock");
    const holderToken = () => {
      try {
        return JSON.parse(readFileSync(lock, "utf8")).token;
      } catch {
        return null;
      }
    };
    let checks = 0;
    let waiting!: () => void;
    const waitingAgain = new Promise<"still waiting for the holder">((resolve) => {
      waiting = () => resolve("still waiting for the holder");
    });
    onProcessRead(host, () => {
      if (holderToken() === token && ++checks === 3) waiting();
    });
    return Promise.race([admission(host).admit(request), waitingAgain]);
  }

  test("a lock whose holder pid now belongs to another process is reaped", async () => {
    writePolicy(1);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "lock"),
      JSON.stringify({ pid: 4_100_003, started: FAKE_STARTED - 600, token: "crashed" }),
    );
    const host = fakeHost();
    host.processes.set(4_100_003, "unrelated");

    const settled = await admitPastLock(host, "crashed", ios(X));

    expect(settled).not.toBe("still waiting for the holder");
    expect(settled).toMatchObject({ ok: true });
    expect(host.reads).toBe(1);
    expect(existsSync(join(stateDir, "lock"))).toBe(false);
  });

  test("a lock whose holder exited but was not reaped by its parent is reaped", async () => {
    writePolicy(1);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "lock"),
      JSON.stringify({ pid: 4_100_005, started: FAKE_STARTED, token: "zombie" }),
    );
    const host = fakeHost();
    host.processes.set(4_100_005, { args: "bun hub", state: "Z" });

    const settled = await admitPastLock(host, "zombie", ios(X));

    expect(settled).not.toBe("still waiting for the holder");
    expect(settled).toMatchObject({ ok: true });
    expect(existsSync(join(stateDir, "lock"))).toBe(false);
  });

  test("a failed process-table read while waiting for the lock refuses the boot", async () => {
    writePolicy(1);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "lock"),
      JSON.stringify({ pid: 4_100_002, started: FAKE_STARTED, token: "live" }),
    );
    const host = fakeHost();
    host.processes.set(4_100_002, "bun hub");
    onProcessRead(host, (read) =>
      read === 1
        ? undefined
        : { value: null, error: { id: "ps", message: "Failed to run `ps`", error: "Error: ps" } },
    );

    const settled = await admitPastLock(host, "live", ios(X));

    expect(settled).not.toBe("still waiting for the holder");
    expect(settled).toMatchObject({ ok: false });
    expect(typeof settled === "object" && !settled.ok && settled.error).toStartWith(
      "Device host capacity could not be checked:",
    );
    expect(host.reads).toBe(0);
    expect(attempts()).toEqual([]);
  });
});
