import * as fileSystem from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as simctlModule from "../../simctl";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
  existsSync,
  copyFileSync,
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as config from "../../capability-config";
import { readLaunchState, writeLaunchState } from "../../launch-state";
import { releaseLaunchState } from "../../launch-manager";
import { useTempStateDir, withShimsAsync } from "../helpers";

const work = mkdtempSync("/tmp/serve-sim-egress-resources-");
const source = join(work, "capability-loader"),
  native = join(work, "egress-guard");
const bootFile = join(work, "boot.json");
const failingSet = join(work, "failing-set");
const pauseBoot = join(work, "pause-boot"),
  enteredBoot = join(work, "entered-boot");
const udid = "11111111-1111-4111-8111-111111111111";
mkdirSync(source);
mkdirSync(native);
writeFileSync(
  join(source, "libServeSimCapabilityLoader.dylib"),
  "loader fixture, not a native image",
);
writeFileSync(join(native, "libServeSimEgressGuard.dylib"), "guard fixture, not a native image");
const originalFixtureDirectory = process.env.SERVE_SIM_EGRESS_FIXTURE_DIRECTORY;
process.env.SERVE_SIM_EGRESS_FIXTURE_DIRECTORY = work;
for (const [target, fixture] of [
  ["serve-sim-egress-boot-identity", new URL("./egress-boot-fixture.cjs", import.meta.url)],
  ["serve-sim-egress-control", new URL("./egress-control-fixture.cjs", import.meta.url)],
  ["serve-sim-egress-check", new URL("./egress-check-fixture.cjs", import.meta.url)],
] as const) {
  copyFileSync(fixture, join(native, target));
  chmodSync(join(native, target), 0o500);
}
const executeCheck = promisify(execFileCallback);
const originalSimctl = simctlModule.simctl;
mock.module("../../simctl", () => ({
  ...simctlModule,
  simctl: async (args: string[], options?: number) => {
    if (args[0] === "spawn") {
      const result = await executeCheck(args[2]!, args.slice(3), { encoding: "utf8" });
      return result.stdout;
    }
    return originalSimctl(args, options);
  },
}));
mock.module("../../capability-config", () => ({
  ...config,
  capabilityLoaderDir: () => source,
  capabilityLoaderPath: (device?: string) => {
    const enrolled = device ? readLaunchState(device)?.capabilities.egressGuard : undefined;
    return join(
      enrolled?.resident ? dirname(enrolled.dylib) : source,
      "libServeSimCapabilityLoader.dylib",
    );
  },
}));
const {
  prepareResidentEgress,
  startResidentEgress,
  bootPreparedResidentEgress,
  checkResidentEgress,
  publishResidentEgressPolicy,
  verifyResidentEgressPolicy,
} = await import("../../egress-resources");
let state: ReturnType<typeof useTempStateDir>;
beforeEach(() => {
  state = useTempStateDir();
  writeFileSync(bootFile, "null");
  rmSync(failingSet, { force: true });
  rmSync(pauseBoot, { force: true });
  rmSync(enteredBoot, { force: true });
  rmSync(join(work, "failing-check"), { force: true });
});

test("policy admission requires a fresh Simulator self-check and retains enrollment on failure", async () => {
  await prepareResidentEgress(udid, "passthrough");
  await withShimsAsync({ xcrun: bootShim(join(state.dir, "self-check-boot")) }, async () => {
    await bootPreparedResidentEgress(udid);
  });
  await verifyResidentEgressPolicy(udid, "passthrough");
  await publishResidentEgressPolicy(udid, "block");
  await verifyResidentEgressPolicy(udid, "block");
  const original = readFileSync(config.capabilityConfigPath(udid));
  for (const failure of ["fail", "mode", "generation", "page"]) {
    writeFileSync(join(work, "failing-check"), failure);
    await expect(publishResidentEgressPolicy(udid, "passthrough")).rejects.toThrow(
      failure === "fail" ? "egress-check" : "did not observe",
    );
    expect(readFileSync(config.capabilityConfigPath(udid))).toEqual(original);
    expect(readLaunchState(udid)!.capabilities.egressGuard!.resident!.boot).not.toBeNull();
  }
});

test("required startup prepares, boots and verifies policy as one transaction", async () => {
  await withShimsAsync({ xcrun: bootShim(join(state.dir, "transaction-boot")) }, async () => {
    const boot = await startResidentEgress(udid, "block", () => {});
    expect(boot).toEqual(readLaunchState(udid)!.capabilities.egressGuard!.resident!.boot!);
  });
  await verifyResidentEgressPolicy(udid, "block");
});

test("transaction cancellation after boot retains pending assets and releases the lock", async () => {
  let calls = 0;
  const log = join(state.dir, "cancelled-transaction");
  await withShimsAsync({ xcrun: bootShim(log) }, async () => {
    await expect(
      startResidentEgress(udid, "block", () => {
        if (++calls === 3) throw new Error("transaction cancelled");
      }),
    ).rejects.toThrow("transaction cancelled");
  });
  const guard = readLaunchState(udid)!.capabilities.egressGuard!;
  expect(guard.resident!.boot).toBeNull();
  expect(existsSync(guard.dylib)).toBe(true);
  expect(existsSync(guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!)).toBe(true);
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  const { withLaunchStateLock } = await import("../../launch-state-lock");
  let acquired = false;
  await withLaunchStateLock(udid, async () => {
    acquired = true;
  });
  expect(acquired).toBe(true);
});

test("transaction reuses a live boot and publishes the requested policy without booting", async () => {
  await withShimsAsync(
    {
      xcrun: bootShim(join(state.dir, "first-transaction"), "own", {
        pid: process.pid,
        startedAt: "1720000000:42",
      }),
    },
    async () => {
      await startResidentEgress(udid, "passthrough", () => {});
    },
  );
  const before = readLaunchState(udid)!.capabilities.egressGuard!;
  const boot = await startResidentEgress(udid, "block", () => {});
  expect(boot).toEqual(before.resident!.boot!);
  expect(readLaunchState(udid)!.capabilities.egressGuard!.env).toEqual(before.env);
  await verifyResidentEgressPolicy(udid, "block");
});

test("right-panel policy actions require current ownership and never enroll a device", async () => {
  const { runHostActionAsync } = await import("../../host-actions");
  const action = (name: string, enabled?: boolean) =>
    runHostActionAsync(
      {
        action: name,
        params: { udid, ...(enabled === undefined ? {} : { enabled }) },
      },
      "unused",
    );
  expect(JSON.parse((await action("egress.status")).stdout)).toEqual({ available: false });
  expect((await action("egress.set", true)).exitCode).toBe(1);
  expect(readLaunchState(udid)).toBeNull();
  await prepareResidentEgress(udid, "passthrough");
  await withShimsAsync({ xcrun: bootShim(join(state.dir, "panel-boot")) }, async () => {
    await bootPreparedResidentEgress(udid);
  });
  const enrolled = readLaunchState(udid)!;
  const page = enrolled.capabilities.egressGuard!.env!.SERVE_SIM_EGRESS_POLICY_FILE!;
  const before = readFileSync(page);
  expect((await action("egress.set", true)).stderr).toContain("does not own");
  expect(readFileSync(page)).toEqual(before);
  writeLaunchState(udid, { ...enrolled, sessionPids: [process.pid] });
  expect(JSON.parse((await action("egress.status")).stdout)).toEqual({
    available: true,
    enabled: false,
  });
  expect(JSON.parse((await action("egress.set", true)).stdout)).toEqual({
    available: true,
    enabled: true,
  });
  expect(JSON.parse((await action("egress.set", false)).stdout)).toEqual({
    available: true,
    enabled: false,
  });
  const shared = readLaunchState(udid)!;
  const unchanged = readFileSync(page);
  writeLaunchState(udid, { ...shared, sessionPids: [process.pid, process.ppid] });
  expect((await action("egress.set", true)).stderr).toContain("another session");
  expect((await action("egress.status")).exitCode).toBe(1);
  expect(readFileSync(page)).toEqual(unchanged);
  writeLaunchState(udid, shared);
  writeFileSync(join(work, "failing-check"), "fail");
  expect((await action("egress.set", true)).exitCode).toBe(1);
  expect(readLaunchState(udid)!.capabilities.egressGuard!.resident).toEqual(
    enrolled.capabilities.egressGuard!.resident,
  );
  await expect(
    runHostActionAsync({ action: "egress.set", params: { udid: "all", enabled: true } }, "unused"),
  ).rejects.toThrow("simulator udid");
  await expect(
    runHostActionAsync({ action: "egress.set", params: { udid, enabled: "true" } }, "unused"),
  ).rejects.toThrow();
});
afterEach(() => state.restore());
afterAll(() => {
  mock.restore();
  if (originalFixtureDirectory === undefined) delete process.env.SERVE_SIM_EGRESS_FIXTURE_DIRECTORY;
  else process.env.SERVE_SIM_EGRESS_FIXTURE_DIRECTORY = originalFixtureDirectory;
  rmSync(work, { recursive: true, force: true });
});

for (const mode of ["passthrough", "block"] as const) {
  test(`explicit ${mode} enrolls before boot and retains the same page through release`, async () => {
    await prepareResidentEgress(udid, mode);
    const cap = readLaunchState(udid)!.capabilities.egressGuard!;
    const page = cap.env!.SERVE_SIM_EGRESS_POLICY_FILE!;
    const inode = lstatSync(page).ino;
    expect(cap.resident?.boot).toBeNull();
    expect(cap.resident?.warmupPolicy).toBe(mode);
    expect(readFileSync(config.capabilityConfigPath(udid), "utf8")).toContain(
      `startup\tprocess\t${cap.dylib}\tSERVE_SIM_EGRESS_POLICY_FILE=${page}`,
    );
    writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
    await bootFixture();
    expect((await checkResidentEgress(udid)).resident?.boot).toEqual({
      pid: 1234,
      startedAt: "1720000000:42",
    });
    await publishResidentEgressPolicy(udid, mode === "block" ? "passthrough" : "block");
    expect(releaseLaunchState(udid, process.pid)).toBe(true);
    expect(lstatSync(page).ino).toBe(inode);
    expect(readFileSync(config.capabilityConfigPath(udid), "utf8")).toContain(
      `SERVE_SIM_EGRESS_POLICY_FILE=${page}`,
    );
    writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000001:42" }));
    await expect(checkResidentEgress(udid)).rejects.toThrow("boot changed");
    expect(existsSync(page)).toBe(true);
  });
}

test("already booted uninstrumented devices cannot be retrofitted", async () => {
  writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
  await expect(prepareResidentEgress(udid, "block")).rejects.toThrow("already-booted");
  expect(readdirSync(state.dir)).not.toContain(`launch-${udid}.json`);
});

test("failed preboot publication restores ordinary config and removes only the new child", async () => {
  const old = "user\t/camera.dylib\t\t0\n";
  writeFileSync(config.capabilityConfigPath(udid), old);
  const sentinel = join(state.dir, "sentinel");
  writeFileSync(sentinel, "preserve");
  mkdirSync(`${config.capabilityConfigPath(udid)}.${process.pid}.tmp`);
  await expect(prepareResidentEgress(udid, "block")).rejects.toThrow();
  expect(readFileSync(config.capabilityConfigPath(udid), "utf8")).toBe(old);
  expect(readFileSync(sentinel, "utf8")).toBe("preserve");
  expect(readdirSync(state.dir).filter((name) => name.startsWith("egress-"))).toHaveLength(0);
});

test("policy failure and failed blocking cleanup preserve both errors and the mapping", async () => {
  await prepareResidentEgress(udid, "passthrough");
  writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
  await bootFixture();
  const page = readLaunchState(udid)!.capabilities.egressGuard!.env!.SERVE_SIM_EGRESS_POLICY_FILE!;
  const inode = lstatSync(page).ino;
  writeFileSync(failingSet, "fail");
  const error = await publishResidentEgressPolicy(udid, "block").catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toHaveLength(2);
  expect(
    (error as AggregateError).errors.every((cause: unknown) =>
      String(cause).includes("fixture set failed"),
    ),
  ).toBe(true);
  expect(lstatSync(page).ino).toBe(inode);
  expect(readLaunchState(udid)!.capabilities.egressGuard!.resident).toBeDefined();
});

test("valid page and native identity cannot hide a missing startup record", async () => {
  await prepareResidentEgress(udid, "passthrough");
  writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
  await bootFixture();
  rmSync(config.capabilityConfigPath(udid));
  await expect(checkResidentEgress(udid)).rejects.toThrow("startup record");
  expect(existsSync(config.capabilityConfigPath(udid))).toBe(false);
});

test("middleware observes a matching resident boot without issuing another boot", async () => {
  await prepareResidentEgress(udid, "passthrough");
  writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
  await bootFixture();
  const nativeLog = join(state.dir, "middleware-calls");
  const { withShimsAsync } = await import("../helpers");
  const { startDeviceInProcess } = await import("../../middleware");
  await withShimsAsync(
    {
      xcrun: `#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(nativeLog)},JSON.stringify(args)+'\\n');
if(args[1]==='bootstatus') process.exit(42);
console.log(JSON.stringify({devices:{}}));
`,
    },
    async () => {
      await expect(startDeviceInProcess(udid, 12345, "/")).rejects.toThrow();
    },
  );
  const calls = readFileSync(nativeLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  expect(calls.some((args) => args[1] === "boot")).toBe(false);
  expect(calls.some((args) => args[1] === "bootstatus")).toBe(true);
  expect(
    calls.filter((args) => args[1] === "bootstatus").every((args) => !args.includes("-b")),
  ).toBe(true);
});

test("another live session cannot change resident policy", async () => {
  await prepareResidentEgress(udid, "passthrough");
  writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
  await bootFixture();
  const current = readLaunchState(udid)!;
  writeLaunchState(udid, { ...current, sessionPids: [process.ppid] });
  const page = current.capabilities.egressGuard!.env!.SERVE_SIM_EGRESS_POLICY_FILE!;
  const before = readFileSync(page);
  await expect(publishResidentEgressPolicy(udid, "block")).rejects.toThrow("another session");
  expect(readFileSync(page)).toEqual(before);
});

test("a replacement boot during the wait cannot run callbacks or publish ready", async () => {
  await prepareResidentEgress(udid, "passthrough");
  writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
  await bootFixture();
  const { withShimsAsync } = await import("../helpers");
  const { startDeviceInProcess } = await import("../../middleware");
  const { stateFileForDevice } = await import("../../state");
  let applied = false;
  await withShimsAsync(
    {
      xcrun: `#!/usr/bin/env node
if(process.argv[3]==='bootstatus') require('fs').writeFileSync(${JSON.stringify(bootFile)},JSON.stringify({pid:1234,startedAt:'1720000001:42'}));
`,
    },
    async () => {
      await expect(
        startDeviceInProcess(udid, 12345, "/", undefined, undefined, async () => {
          applied = true;
        }),
      ).rejects.toThrow("boot changed");
    },
  );
  expect(applied).toBe(false);
  expect(existsSync(stateFileForDevice(udid))).toBe(false);
});

// Exercise the existing private owner channel, with only the boot/controller executables modeled.
async function ownerFixture(
  run: (value: {
    adopt(policy?: "block" | "passthrough"): Promise<unknown>;
    configured(): number;
    ownerFile: string;
    raw(policy?: "block" | "passthrough"): Promise<Record<string, unknown>>;
    disconnectDuringPreflight(): Promise<void>;
  }) => Promise<void>,
) {
  const { resolve } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { adoptSession, bootSession, sessionEnvironment, sessionOwnerFile, startSessionOwner } =
    await import("../../session-owner");
  const { inProcessServeSimState, stateDir, writeServeSimState } = await import("../../state");
  const { DEFAULT_STREAM_ENCODER_SETTINGS } = await import("../../stream-settings");
  let configured = 0;
  const identity = {
    version: "fixture",
    pid: process.pid,
    device: udid,
    bootSession: bootSession(),
    host: "127.0.0.1",
    port: 3200,
    stateDirectory: resolve(stateDir()),
    temporaryDirectory: resolve(tmpdir()),
    environment: sessionEnvironment(),
  };
  const owner = await startSessionOwner(
    udid,
    () => identity,
    async () => {
      configured++;
    },
  );
  writeServeSimState({ ...inProcessServeSimState(udid, 3200), token: "preview-token" });
  const directory = JSON.parse(readFileSync(sessionOwnerFile(3200), "utf8")).directory;
  const secret = readFileSync(join(directory, "authority"), "utf8");
  const configuration = (egressPolicy?: "block" | "passthrough") => ({
    stream: { transport: "webrtc", codec: "h264", ...DEFAULT_STREAM_ENCODER_SETTINGS },
    corsOrigins: [],
    frameAncestors: [],
    disableShare: false,
    networkCapture: false,
    networkCaptureFields: [],
    egressPolicy,
  });
  const { createConnection } = await import("node:net");
  const connect = () => createConnection(join(directory, "control.sock"));
  const body = (policy?: "block" | "passthrough") =>
    JSON.stringify({
      secret,
      method: "configure",
      identity,
      configuration: configuration(policy),
    }) + "\n";
  try {
    await run({
      ownerFile: sessionOwnerFile(3200),
      raw: (policy) =>
        new Promise((resolve, reject) => {
          const socket = connect();
          let data = "";
          socket.setTimeout(3000, () => socket.destroy(new Error("owner fixture timeout")));
          socket.on("error", reject);
          socket.once("connect", () => socket.write(body(policy)));
          socket.on("data", (chunk) => {
            data += chunk;
            if (data.includes("\n")) {
              const response = JSON.parse(data);
              socket.once("close", () => resolve(response));
              socket.destroy();
            }
          });
        }),
      disconnectDuringPreflight: async () => {
        writeFileSync(pauseBoot, "pause");
        const socket = connect();
        try {
          await new Promise<void>((resolve, reject) => {
            socket.once("error", reject);
            socket.once("connect", () => {
              socket.write(body("block"));
              resolve();
            });
          });
          const deadline = Date.now() + 3000;
          while (!existsSync(enteredBoot)) {
            if (Date.now() > deadline) throw new Error("preflight did not enter boot check");
            await new Promise((r) => setTimeout(r, 5));
          }
          const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
          socket.destroy();
          await closed;
          // Deliver the peer close before allowing its blocked preflight to resume.
          await new Promise((r) => setTimeout(r, 20));
        } finally {
          socket.destroy();
          rmSync(pauseBoot, { force: true });
        }
        const { withLaunchStateLock } = await import("../../launch-state-lock");
        await withLaunchStateLock(udid, async () => {});
      },
      configured: () => configured,
      adopt: (egressPolicy) =>
        adoptSession(udid, "fixture", "127.0.0.1", 3200, {
          stream: { transport: "webrtc", codec: "h264", ...DEFAULT_STREAM_ENCODER_SETTINGS },
          corsOrigins: [],
          frameAncestors: [],
          disableShare: false,
          networkCapture: false,
          networkCaptureFields: [],
          egressPolicy,
        }),
    });
  } finally {
    owner.close();
  }
}

for (const policy of ["block", "passthrough"] as const) {
  test(`private ${policy} adoption publishes and self-checks before configuration`, async () => {
    await prepareResidentEgress(udid, "passthrough");
    writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
    await bootFixture();
    const cap = readLaunchState(udid)!.capabilities.egressGuard!;
    const page = cap.env!.SERVE_SIM_EGRESS_POLICY_FILE!;
    const configBefore = readFileSync(config.capabilityConfigPath(udid));
    await ownerFixture(async ({ adopt, configured, ownerFile, raw }) => {
      await expect(adopt()).rejects.toThrow("explicit");
      expect(await raw()).toEqual({ ok: false, error: "session_configuration_failed" });
      expect(existsSync(ownerFile)).toBe(true);
      await adopt(policy);
      expect(configured()).toBe(1);
      expect(existsSync(ownerFile)).toBe(false);
      await expect(adopt(policy)).rejects.toThrow();
    });
    expect(Number(readFileSync(page).readBigUInt64LE(8) & 3n)).toBe(policy === "block" ? 2 : 1);
    expect(readFileSync(config.capabilityConfigPath(udid))).toEqual(configBefore);
  });
}

test("a changed native boot rejects private adoption before consuming authority", async () => {
  await prepareResidentEgress(udid, "passthrough");
  const boot = { pid: 1234, startedAt: "1720000000:42" };
  writeFileSync(bootFile, JSON.stringify(boot));
  await bootFixture();
  await ownerFixture(async ({ adopt, configured, ownerFile }) => {
    writeFileSync(bootFile, JSON.stringify({ ...boot, startedAt: "1720000001:42" }));
    await expect(adopt("block")).rejects.toThrow("boot changed");
    expect(existsSync(ownerFile)).toBe(true);
    expect(configured()).toBe(0);
    writeFileSync(bootFile, JSON.stringify(boot));
    await adopt("block");
    expect(configured()).toBe(1);
    expect(existsSync(ownerFile)).toBe(false);
  });
});

test("an ordinary uninstrumented owner rejects egress without consuming its normal claim", async () => {
  await ownerFixture(async ({ adopt, configured, ownerFile }) => {
    await expect(adopt("block")).rejects.toThrow("No compatible resident");
    expect(existsSync(ownerFile)).toBe(true);
    await adopt();
    expect(configured()).toBe(1);
    expect(existsSync(ownerFile)).toBe(false);
  });
});

test("disconnect during resident compatibility does not consume a claim or publish policy", async () => {
  await prepareResidentEgress(udid, "passthrough");
  writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
  await bootFixture();
  const page = readLaunchState(udid)!.capabilities.egressGuard!.env!.SERVE_SIM_EGRESS_POLICY_FILE!;
  const before = readFileSync(page);
  await ownerFixture(async ({ disconnectDuringPreflight, ownerFile, configured, adopt }) => {
    await disconnectDuringPreflight();
    expect(existsSync(ownerFile)).toBe(true);
    expect(configured()).toBe(0);
    expect(readFileSync(page)).toEqual(before);
    await adopt("block");
    expect(configured()).toBe(1);
    expect(existsSync(ownerFile)).toBe(false);
  });
});

function bootShim(
  log: string,
  mode: "own" | "already-booted" | "replace" = "own",
  started = { pid: 5678, startedAt: "1720000000:42" },
) {
  return `#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,insert:process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES,config:process.env.SIMCTL_CHILD_SERVE_SIM_CAPABILITIES_CONFIG})+'\\n');
if(args[1]==='boot') {
 if(${JSON.stringify(mode)}==='already-booted') {console.error('Unable to boot device in current state: Booted');process.exit(1);}
 fs.writeFileSync(${JSON.stringify(bootFile)},JSON.stringify(${JSON.stringify(started)}));
} else if(args[1]==='bootstatus') {
 if(args.length!==3) process.exit(99);
 if(${JSON.stringify(mode)}==='replace') fs.writeFileSync(${JSON.stringify(bootFile)},JSON.stringify({pid:5678,startedAt:'1720000001:42'}));
} else process.exit(99);
`;
}

for (const mode of ["own", "already-booted", "replace"] as const) {
  test(`strict resident boot ${mode} preserves ownership and never bootstraps from a wait`, async () => {
    await prepareResidentEgress(udid, "block");
    const log = join(state.dir, "boot-calls");
    const guard = readLaunchState(udid)!.capabilities.egressGuard!;
    const inode = lstatSync(guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!).ino;
    await withShimsAsync({ xcrun: bootShim(log, mode) }, async () => {
      if (mode === "own") await bootPreparedResidentEgress(udid);
      else
        await expect(bootPreparedResidentEgress(udid)).rejects.toThrow(
          mode === "replace" ? "boot changed" : "Booted",
        );
    });
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls[0].args).toEqual(["simctl", "boot", udid]);
    expect(calls[0].insert.split(":")).toContain(guard.dylib);
    expect(calls[0].config).toBe(config.capabilityConfigPath(udid));
    if (mode === "already-booted") expect(calls).toHaveLength(1);
    else expect(calls[1].args).toEqual(["simctl", "bootstatus", udid]);
    expect(readLaunchState(udid)!.capabilities.egressGuard!.resident!.boot).toEqual(
      mode === "own" ? { pid: 5678, startedAt: "1720000000:42" } : null,
    );
    expect(lstatSync(guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!).ino).toBe(inode);
  });
}

test("a foreign boot after preparation is refused before native boot or binding", async () => {
  await prepareResidentEgress(udid, "block");
  writeFileSync(bootFile, JSON.stringify({ pid: 9000, startedAt: "1720000000:42" }));
  const log = join(state.dir, "boot-calls");
  await withShimsAsync({ xcrun: bootShim(log) }, async () => {
    await expect(bootPreparedResidentEgress(udid)).rejects.toThrow("already-booted");
  });
  expect(existsSync(log)).toBe(false);
  expect(readLaunchState(udid)!.capabilities.egressGuard!.resident!.boot).toBeNull();
});

test("cancellation after starting a resident boot retains unbound assets and stops readiness", async () => {
  await prepareResidentEgress(udid, "block");
  const log = join(state.dir, "boot-calls");
  let calls = 0;
  await withShimsAsync({ xcrun: bootShim(log) }, async () => {
    await expect(
      bootPreparedResidentEgress(udid, () => {
        if (++calls === 2) throw new Error("startup cancelled");
      }),
    ).rejects.toThrow("startup cancelled");
  });
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  const guard = readLaunchState(udid)!.capabilities.egressGuard!;
  expect(guard.resident!.boot).toBeNull();
  expect(existsSync(guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!)).toBe(true);
});

async function bootFixture() {
  const started = JSON.parse(readFileSync(bootFile, "utf8"));
  writeFileSync(bootFile, "null");
  await withShimsAsync(
    { xcrun: bootShim(join(state.dir, "fixture-boot-calls"), "own", started) },
    () => bootPreparedResidentEgress(udid),
  );
}

async function recordedDeadBoot() {
  const child = Bun.spawn([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return { pid: child.pid, startedAt: "1720000000:42" };
}
async function retirementFixture(
  run: (old: NonNullable<ReturnType<typeof readLaunchState>>) => Promise<void>,
) {
  await prepareResidentEgress(udid, "passthrough");
  const old = readLaunchState(udid)!;
  old.capabilities.egressGuard!.resident!.boot = await recordedDeadBoot();
  writeLaunchState(udid, old);
  writeFileSync(
    join(work, "device-state.json"),
    JSON.stringify({ devices: { iOS: [{ udid, state: "Shutdown" }] } }),
  );
  await withShimsAsync(
    {
      xcrun: {
        sourceFile: fileURLToPath(new URL("./egress-retirement-simctl.cjs", import.meta.url)),
      },
    },
    () => run(old),
  );
}

test("a confirmed dead boot can be enrolled again without deleting unrelated files or inserts", async () => {
  await retirementFixture(async (old) => {
    const guard = old.capabilities.egressGuard!;
    const directory = dirname(guard.dylib);
    old.capabilities.clipboard = {
      name: "clipboard",
      dylib: "/unrelated/clipboard.dylib",
      scope: "allApps",
      loadPhase: "deferred",
      ownerPid: null,
      bundleId: null,
    };
    writeLaunchState(udid, old);
    config.commitCapabilityConfig(udid, config.renderCapabilityConfig(old));
    const sentinel = join(state.dir, "unrelated");
    writeFileSync(sentinel, "keep");
    config.writeManagedStartupDylibs(udid, [guard.dylib, "/unrelated/library.dylib"]);
    await prepareResidentEgress(udid, "block");
    const replacement = readLaunchState(udid)!.capabilities.egressGuard!;
    expect(replacement.dylib).not.toBe(guard.dylib);
    expect(readLaunchState(udid)!.capabilities.clipboard).toEqual(old.capabilities.clipboard);
    expect(replacement.resident!.warmupPolicy).toBe("block");
    expect(replacement.resident!.boot).toBeNull();
    expect(existsSync(directory)).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    expect(config.managedStartupDylibs(udid)).toEqual(["/unrelated/library.dylib"]);
    expect(readFileSync(config.capabilityConfigPath(udid), "utf8")).not.toContain(guard.dylib);
  });
});

for (const uncertainty of [
  "live-pid",
  "pending",
  "booted-state",
  "replacement",
  "unknown-state",
  "foreign-owner",
] as const) {
  test(`uncertain boot retirement retains enrollment and assets: ${uncertainty}`, async () => {
    await retirementFixture(async (old) => {
      const guard = old.capabilities.egressGuard!;
      if (uncertainty === "live-pid") guard.resident!.boot!.pid = process.pid;
      if (uncertainty === "pending") guard.resident!.boot = null;
      if (uncertainty === "foreign-owner") old.sessionPids = [process.ppid];
      writeLaunchState(udid, old);
      if (uncertainty === "booted-state")
        writeFileSync(
          join(work, "device-state.json"),
          JSON.stringify({ devices: { iOS: [{ udid, state: "Booted" }] } }),
        );
      if (uncertainty === "unknown-state")
        writeFileSync(join(work, "device-state.json"), JSON.stringify({ devices: {} }));
      if (uncertainty === "replacement")
        writeFileSync(bootFile, JSON.stringify({ pid: process.pid, startedAt: "1720000001:42" }));
      const metadata = readFileSync(join(state.dir, `launch-${udid}.json`));
      const configBefore = readFileSync(config.capabilityConfigPath(udid));
      const page = readFileSync(guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!);
      const expected = {
        "live-pid": "Simulator boot changed; the old resident egress enrollment cannot be reused",
        pending: "Pending resident boot identity is uncertain; retain its enrollment",
        "booted-state": "Resident Simulator boot death is unconfirmed; retain its enrollment",
        replacement: "Resident Simulator boot death is unconfirmed; retain its enrollment",
        "unknown-state": "Resident Simulator boot death is unconfirmed; retain its enrollment",
        "foreign-owner": `Resident egress on ${udid} belongs to another session; stop it before changing policy.`,
      }[uncertainty];
      await expect(prepareResidentEgress(udid, "block")).rejects.toThrow(expected);
      expect(readFileSync(join(state.dir, `launch-${udid}.json`))).toEqual(metadata);
      expect(readFileSync(config.capabilityConfigPath(udid))).toEqual(configBefore);
      expect(readFileSync(guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!)).toEqual(page);
    });
  });
}

test("dead-boot cleanup never recursively removes unexpected files", async () => {
  await retirementFixture(async (old) => {
    const directory = dirname(old.capabilities.egressGuard!.dylib);
    const sentinel = join(directory, "unexpected");
    writeFileSync(sentinel, "keep");
    await expect(prepareResidentEgress(udid, "block")).rejects.toThrow(
      "Could not remove retired resident assets",
    );
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    expect(readLaunchState(udid)?.capabilities.egressGuard).toBeUndefined();
  });
});

test("metadata failure restores enrollment/config/inserts before any asset deletion", async () => {
  await retirementFixture(async (old) => {
    const target = join(state.dir, `launch-${udid}.json`);
    const metadata = readFileSync(target);
    const configBefore = readFileSync(config.capabilityConfigPath(udid));
    config.writeManagedStartupDylibs(udid, [old.capabilities.egressGuard!.dylib]);
    const rename = fileSystem.renameSync;
    let failed = false;
    const injected = spyOn(fileSystem, "renameSync").mockImplementation((from, to) => {
      if (to === target && !failed) {
        failed = true;
        throw new Error("metadata fixture failure");
      }
      rename(from, to);
    });
    try {
      await expect(prepareResidentEgress(udid, "block")).rejects.toThrow(
        "metadata fixture failure",
      );
      expect(failed).toBe(true);
      expect(readFileSync(target)).toEqual(metadata);
      expect(readFileSync(config.capabilityConfigPath(udid))).toEqual(configBefore);
      expect(config.managedStartupDylibs(udid)).toEqual([old.capabilities.egressGuard!.dylib]);
      expect(existsSync(old.capabilities.egressGuard!.env!.SERVE_SIM_EGRESS_POLICY_FILE!)).toBe(
        true,
      );
    } finally {
      injected.mockRestore();
    }
  });
});

test("matching live enrollment is reused without changing its immutable policy or page", async () => {
  await prepareResidentEgress(udid, "passthrough");
  const old = readLaunchState(udid)!;
  const boot = { pid: process.pid, startedAt: "1720000000:42" };
  old.capabilities.egressGuard!.resident!.boot = boot;
  writeLaunchState(udid, old);
  writeFileSync(bootFile, JSON.stringify(boot));
  const page = old.capabilities.egressGuard!.env!.SERVE_SIM_EGRESS_POLICY_FILE!;
  const contents = readFileSync(page);
  expect(await prepareResidentEgress(udid, "block")).toBe(false);
  expect(readLaunchState(udid)).toEqual(old);
  expect(readFileSync(page)).toEqual(contents);
});

for (const fault of [
  "directory-mode",
  "policy-path",
  "changed-artifact",
  "invalid-probe",
  "probe-error",
] as const) {
  test(`reclamation safety rejects ${fault} before any mutation`, async () => {
    await retirementFixture(async (old) => {
      const guard = old.capabilities.egressGuard!;
      const directory = dirname(guard.dylib);
      if (fault === "directory-mode") chmodSync(directory, 0o755);
      if (fault === "policy-path") {
        const alias = join(state.dir, "policy-alias");
        linkSync(guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!, alias);
        guard.env!.SERVE_SIM_EGRESS_POLICY_FILE = alias;
        writeLaunchState(udid, old);
        config.commitCapabilityConfig(udid, config.renderCapabilityConfig(old));
      }
      if (fault === "changed-artifact") {
        chmodSync(guard.dylib, 0o600);
        writeFileSync(guard.dylib, "altered artifact");
      }
      if (fault === "invalid-probe") writeFileSync(bootFile, JSON.stringify({ pid: 0 }));
      if (fault === "probe-error") rmSync(bootFile);
      const metadata = readFileSync(join(state.dir, `launch-${udid}.json`));
      const configBefore = readFileSync(config.capabilityConfigPath(udid));
      const page = readFileSync(guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!);
      const expected =
        fault === "directory-mode" || fault === "policy-path"
          ? "Invalid resident asset directory; retain its enrollment"
          : fault === "changed-artifact"
            ? "Resident egress artifact changed; preserve the old boot assets"
            : fault === "invalid-probe"
              ? "Invalid Simulator boot identity"
              : "Command failed:";
      await expect(prepareResidentEgress(udid, "block")).rejects.toThrow(expected);
      expect(readFileSync(join(state.dir, `launch-${udid}.json`))).toEqual(metadata);
      expect(readFileSync(config.capabilityConfigPath(udid))).toEqual(configBefore);
      expect(readFileSync(guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!)).toEqual(page);
      expect(existsSync(join(directory, "policy"))).toBe(true);
    });
  });
}
