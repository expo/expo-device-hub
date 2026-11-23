/// <reference types="bun" />

/**
 * Boot admission across Hub helper processes. Each helper is its own process
 * and namespace, like the Hub helpers T3 runs under one OS account; they share
 * one fake device host and one host policy. Every step waits for an IPC
 * milestone from a helper, never for time.
 *
 * This file imports no boot-admission code, so it also loads on a source tree
 * without it; there the cross-process refusal fails by its assertion.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type FakeHostState,
  type HelperCommand,
  type HelperMessage,
  initialFakeHost,
  readFakeHost,
  updateFakeHost,
  writeFakeHost,
} from "./fixtures/boot-admission-fake-host";

const FIXTURE = join(import.meta.dir, "fixtures", "boot-admission-helper.fixture.ts");

const X = "11111111-1111-1111-1111-111111111111";
const Y = "22222222-2222-2222-2222-222222222222";
const Z = "33333333-3333-3333-3333-333333333333";

type BootResult = Extract<HelperMessage, { type: "result" }>["result"];
type MessageType = HelperMessage["type"];

interface Scratch {
  dir: string;
  hostFile: string;
  policyFile: string;
  stateDir: string;
}

const scratches: Scratch[] = [];
const helpers: Helper[] = [];

/** A scratch host: fake device state plus a policy file when `maxVirtualDevices` is given. */
function createScratch(
  maxVirtualDevices: number | null,
  setup: (state: FakeHostState) => void = () => {},
): Scratch {
  const dir = mkdtempSync(join(tmpdir(), "boot-admission-"));
  const scratch = {
    dir,
    hostFile: join(dir, "fake-host.json"),
    policyFile: join(dir, "device-hub", "host-policy.json"),
    stateDir: join(dir, "device-hub", "boot-admission"),
  };
  const state = initialFakeHost();
  state.simulators[X] = { name: "iPhone X", state: "Shutdown" };
  state.simulators[Y] = { name: "iPhone Y", state: "Shutdown" };
  setup(state);
  writeFakeHost(scratch.hostFile, state);
  if (maxVirtualDevices !== null) {
    mkdirSync(join(dir, "device-hub"));
    writeFileSync(scratch.policyFile, JSON.stringify({ maxVirtualDevices }));
  }
  scratches.push(scratch);
  return scratch;
}

/** The boot-attempt records currently on disk. */
function attempts(scratch: Scratch): string[] {
  if (!existsSync(scratch.stateDir)) return [];
  return readdirSync(scratch.stateDir).filter((name) => /^attempt-.*\.json$/.test(name));
}

class Helper {
  private readonly buffered: HelperMessage[] = [];
  private readonly received: HelperMessage[] = [];
  private readonly waiters: {
    types: MessageType[];
    resolve: (message: HelperMessage) => void;
    reject: (error: Error) => void;
  }[] = [];
  private readonly child: ReturnType<typeof Bun.spawn>;

  constructor(
    private readonly scratch: Scratch,
    namespace: string,
  ) {
    this.child = Bun.spawn([process.execPath, FIXTURE], {
      env: {
        ...process.env,
        BOOT_ADMISSION_FAKE_HOST: scratch.hostFile,
        BOOT_ADMISSION_POLICY_FILE: scratch.policyFile,
        BOOT_ADMISSION_STATE_DIR: scratch.stateDir,
        // Each helper is its own Hub namespace.
        EXPO_DEVICE_HUB_STATE_DIR: join(scratch.dir, `namespace-${namespace}`),
      },
      stdout: "inherit",
      stderr: "inherit",
      ipc: (message: HelperMessage) => this.receive(message),
    });
    void this.child.exited.then((code) => {
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(new Error(`helper ${namespace} exited with ${code}`));
      }
    });
    helpers.push(this);
  }

  private receive(message: HelperMessage): void {
    this.received.push(message);
    const index = this.waiters.findIndex((waiter) => waiter.types.includes(message.type));
    if (index === -1) {
      this.buffered.push(message);
      return;
    }
    this.waiters.splice(index, 1)[0]!.resolve(message);
  }

  /** The next message of one of `types`, buffered or still to come. */
  next(...types: MessageType[]): Promise<HelperMessage> {
    const index = this.buffered.findIndex((message) => types.includes(message.type));
    if (index !== -1) return Promise.resolve(this.buffered.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => this.waiters.push({ types, resolve, reject }));
  }

  /** Every device whose native boot step ran in this helper. */
  started(): string[] {
    return this.received.flatMap((message) =>
      message.type === "boot-started" ? [message.device] : [],
    );
  }

  occupancyReads(): number {
    return this.received.filter((message) => message.type === "occupancy-read").length;
  }

  send(command: HelperCommand): void {
    this.child.send(command);
  }

  async result(): Promise<BootResult> {
    const message = await this.next("result");
    if (message.type !== "result") throw new Error(`unexpected ${message.type}`);
    return message.result;
  }

  async boot(request: { platform: "ios" | "android"; id: string; name: string }) {
    this.send({ type: "boot", request });
    return this.result();
  }

  get pid(): number {
    return this.child.pid;
  }

  async exit(): Promise<void> {
    this.send({ type: "exit" });
    await this.child.exited;
    updateFakeHost(this.scratch.hostFile, (state) => {
      delete state.processes[String(this.pid)];
    });
  }

  kill(): void {
    this.child.kill();
  }
}

async function startHelper(scratch: Scratch, namespace: string): Promise<Helper> {
  const helper = new Helper(scratch, namespace);
  await helper.next("ready");
  // The helper is a Hub process in the host's process table.
  updateFakeHost(scratch.hostFile, (state) => {
    state.processes[String(helper.pid)] = `bun hub-${namespace}`;
  });
  return helper;
}

function ios(udid: string) {
  return { platform: "ios" as const, id: udid, name: "" };
}

function android(name: string, id = "") {
  return { platform: "android" as const, id, name };
}

function cleanUp() {
  for (const helper of helpers.splice(0)) helper.kill();
  for (const scratch of scratches.splice(0)) rmSync(scratch.dir, { recursive: true, force: true });
}

describe("two Hub namespaces sharing a host with capacity one", () => {
  let scratch: Scratch;
  let a: Helper;
  let b: Helper;

  beforeAll(async () => {
    scratch = createScratch(1);
    [a, b] = await Promise.all([startHelper(scratch, "a"), startHelper(scratch, "b")]);
  });
  afterAll(cleanUp);

  test("A's boot of X reaches its boot milestone", async () => {
    a.send({ type: "boot", request: ios(X), hold: true });

    expect(await a.next("boot-started")).toEqual({ type: "boot-started", device: X });
  });

  test("B's different device is refused before its boot executes", async () => {
    b.send({ type: "boot", request: ios(Y) });

    const first = await b.next("result", "boot-started");
    expect(first.type).toBe("result");
    expect(b.started()).toEqual([]);
    expect(first.type === "result" && first.result).toMatchObject({
      ok: false,
      errors: [],
    });
    expect(first.type === "result" && first.result.error).toStartWith(
      "Device host capacity reached: 1 of 1 virtual devices are booted or starting on this host.",
    );
    expect(readFakeHost(scratch.hostFile).simulators[Y]?.state).toBe("Shutdown");
  });

  test("A's boot completes once released", async () => {
    a.send({ type: "release" });

    expect(await a.result()).toMatchObject({ ok: true, id: X });
    expect(readFakeHost(scratch.hostFile).simulators[X]?.state).toBe("Booted");
  });

  test("X keeps its slot after A's helper closes", async () => {
    await a.exit();

    const refused = await b.boot(ios(Y));
    expect(refused.ok).toBe(false);
    expect(refused.error).toStartWith("Device host capacity reached: 1 of 1");
    expect(b.started()).toEqual([]);
    expect(attempts(scratch)).toHaveLength(1);
  });

  test("reopening X is admitted without taking a second slot", async () => {
    expect(await b.boot(ios(X))).toMatchObject({ ok: true, id: X });
    expect(b.started()).toEqual([X]);
    expect(attempts(scratch)).toHaveLength(1);

    expect((await b.boot(ios(Y))).ok).toBe(false);
    expect(b.started()).toEqual([X]);
  });

  test("Y is admitted after X's confirmed shutdown", async () => {
    updateFakeHost(scratch.hostFile, (state) => {
      state.simulators[X]!.state = "Shutdown";
    });

    expect(await b.boot(ios(Y))).toMatchObject({ ok: true, id: Y });
    expect(b.started()).toEqual([X, Y]);
    expect(readFakeHost(scratch.hostFile).simulators[Y]?.state).toBe("Booted");
    // X's record was deleted once its absence was confirmed; Y's is new.
    expect(attempts(scratch)).toHaveLength(1);
  });
});

describe("boot outcomes with capacity one", () => {
  afterEach(cleanUp);

  test.each([
    [
      "a port allocation failure",
      { port: null },
      "Failed to allocate an emulator port for Pixel_9",
    ],
    ["a spawn error", { spawnError: true }, "Failed to spawn emulator for Pixel_9"],
  ] as const)("%s rolls back its unused attempt", async (_, scenario, error) => {
    const scratch = createScratch(1, (state) => Object.assign(state.android, scenario));
    const helper = await startHelper(scratch, "a");

    expect(await helper.boot(android("Pixel_9"))).toMatchObject({ ok: false, error });
    expect(attempts(scratch)).toEqual([]);

    updateFakeHost(scratch.hostFile, (state) => {
      state.android = { ...initialFakeHost().android, port: 5562 };
    });
    expect(await helper.boot(android("Pixel_8"))).toMatchObject({
      ok: true,
      id: "emulator-5562",
    });
  });

  test("an emulator that exits after spawn keeps its slot while adb still lists it", async () => {
    const scratch = createScratch(1, (state) => {
      state.android.exitCode = 1;
    });
    const helper = await startHelper(scratch, "a");

    const failed = await helper.boot(android("Pixel_9"));
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("exited with code 1 before coming online");
    expect(attempts(scratch)).toHaveLength(1);

    updateFakeHost(scratch.hostFile, (state) => {
      state.android = { ...initialFakeHost().android, port: 5562, pid: 4_100_002 };
    });
    // The process is gone, but adb still lists emulator-5560.
    expect((await helper.boot(android("Pixel_8"))).ok).toBe(false);

    updateFakeHost(scratch.hostFile, (state) => {
      delete state.adb["emulator-5560"];
    });
    expect(await helper.boot(android("Pixel_8"))).toMatchObject({
      ok: true,
      id: "emulator-5562",
    });
    expect(helper.started()).toEqual(["Pixel_9", "Pixel_8"]);
  });

  test.each([
    ["never comes online", { neverOnline: true }],
    ["fails its online wait", { waitError: true }],
  ] as const)("an emulator that %s keeps its slot while its process lives", async (_, scenario) => {
    const scratch = createScratch(1, (state) => Object.assign(state.android, scenario));
    const helper = await startHelper(scratch, "a");

    expect((await helper.boot(android("Pixel_9"))).ok).toBe(false);
    expect(attempts(scratch)).toHaveLength(1);

    updateFakeHost(scratch.hostFile, (state) => {
      state.android = { ...initialFakeHost().android, port: 5562, pid: 4_100_002 };
      // adb no longer lists it, but the emulator process is alive.
      delete state.adb["emulator-5560"];
    });
    expect((await helper.boot(android("Pixel_8"))).ok).toBe(false);

    updateFakeHost(scratch.hostFile, (state) => {
      delete state.processes["4100001"];
    });
    expect(await helper.boot(android("Pixel_8"))).toMatchObject({ ok: true });
    expect(attempts(scratch)).toHaveLength(1);
  });

  test("an emulator that finds another AVD on its port is stopped and its record finished", async () => {
    const scratch = createScratch(2, (state) => {
      state.adb["emulator-5560"] = { avdName: "Pixel_7", state: "device" };
    });
    const helper = await startHelper(scratch, "a");

    expect(await helper.boot(android("Pixel_9"))).toMatchObject({
      ok: false,
      error: expect.stringContaining('"Pixel_7" is already running on emulator-5560'),
    });
    expect(readFakeHost(scratch.hostFile).processes["4100001"]).toBeUndefined();
    expect(attempts(scratch)).toHaveLength(1);
  });

  test("an Android reopen by AVD name or by serial is idempotent", async () => {
    const scratch = createScratch(1);
    const helper = await startHelper(scratch, "a");

    expect(await helper.boot(android("Pixel_9"))).toMatchObject({
      ok: true,
      id: "emulator-5560",
    });
    expect(readFakeHost(scratch.hostFile).adb["emulator-5560"]).toEqual({
      avdName: "Pixel_9",
      state: "device",
    });

    expect((await helper.boot(android("Pixel_9"))).ok).toBe(true);
    // Admitted without a slot, so its boot runs (see `started()`). It spawns
    // `-avd emulator-5560` on the fake's one port, finds Pixel_9 there and stops
    // its own process.
    updateFakeHost(scratch.hostFile, (state) => {
      state.android.pid = 4_100_002;
    });
    expect(await helper.boot(android("", "emulator-5560"))).toMatchObject({
      ok: false,
      error: expect.stringContaining('"Pixel_9" is already running on emulator-5560'),
    });
    const { processes } = readFakeHost(scratch.hostFile);
    expect([processes["4100001"], processes["4100002"]]).toEqual([
      "emulator -avd Pixel_9 -port 5560",
      undefined,
    ]);
    expect(attempts(scratch)).toHaveLength(1);

    const refused = await helper.boot(android("Pixel_8"));
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("before booting Pixel_8");
    expect(helper.started()).toEqual(["Pixel_9", "Pixel_9", "emulator-5560"]);
  });

  test("a failed simctl boot keeps its slot until the simulator is shut down", async () => {
    const scratch = createScratch(1, (state) => {
      state.iosBootFails = true;
    });
    const helper = await startHelper(scratch, "a");

    expect((await helper.boot(ios(X))).ok).toBe(false);
    expect(readFakeHost(scratch.hostFile).simulators[X]?.state).toBe("Booting");
    expect(attempts(scratch)).toHaveLength(1);
    expect((await helper.boot(ios(Y))).ok).toBe(false);

    updateFakeHost(scratch.hostFile, (state) => {
      state.iosBootFails = false;
      state.simulators[X]!.state = "Shutdown";
    });
    expect(await helper.boot(ios(Y))).toMatchObject({ ok: true, id: Y });
    expect(helper.started()).toEqual([X, Y]);
  });

  test("a failed create rolls back, and a created simulator counts by its UDID", async () => {
    const scratch = createScratch(1);
    const helper = await startHelper(scratch, "a");
    const create = {
      type: "create",
      request: { platform: "ios", name: "iPhone Z", runtime: "iOS-26", deviceType: "iPhone" },
    } as const;

    helper.send(create);
    expect(await helper.result()).toMatchObject({
      ok: false,
      error: "Failed to create iOS simulator iPhone Z",
    });
    expect(attempts(scratch)).toEqual([]);

    updateFakeHost(scratch.hostFile, (state) => {
      state.iosCreateUdid = Z;
    });
    helper.send(create);
    expect(await helper.result()).toMatchObject({ ok: true, id: Z });
    expect(attempts(scratch)).toHaveLength(1);

    expect((await helper.boot(ios(X))).ok).toBe(false);
    expect(await helper.boot(ios(Z))).toMatchObject({ ok: true, id: Z });
    expect(attempts(scratch)).toHaveLength(1);
  });
});

describe("without a host policy", () => {
  afterEach(cleanUp);

  test("boots run unchanged, without reading occupancy or writing state", async () => {
    const scratch = createScratch(null);
    const helper = await startHelper(scratch, "a");

    expect(await helper.boot(ios(X))).toMatchObject({ ok: true, id: X });
    expect(await helper.boot(ios(Y))).toMatchObject({ ok: true, id: Y });
    expect(helper.started()).toEqual([X, Y]);
    expect(helper.occupancyReads()).toBe(0);
    expect(existsSync(join(scratch.dir, "device-hub"))).toBe(false);
  });
});
