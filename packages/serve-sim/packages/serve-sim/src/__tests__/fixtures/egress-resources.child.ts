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

test("a foreign exclusive reservation without session PIDs prevents enrollment", async () => {
  writeLaunchState(udid, { launchArgs: [], capabilities: {}, exclusivePid: process.ppid });
  const file = join(state.dir, `launch-${udid}.json`);
  const before = readFileSync(file);
  await expect(prepareResidentEgress(udid, "passthrough")).rejects.toThrow("another session");
  expect(readFileSync(file)).toEqual(before);
  expect(readdirSync(state.dir).filter((name) => name.startsWith("egress-"))).toEqual([]);
});

test("a foreign exclusive reservation cannot change an enrolled policy page", async () => {
  await prepareResidentEgress(udid, "passthrough");
  await withShimsAsync({ xcrun: bootShim(join(state.dir, "reservation-boot")) }, () =>
    bootPreparedResidentEgress(udid),
  );
  const stateBefore = readLaunchState(udid)!;
  writeLaunchState(udid, { ...stateBefore, sessionPids: [], exclusivePid: process.ppid });
  const page = stateBefore.capabilities.egressGuard!.env!.SERVE_SIM_EGRESS_POLICY_FILE!;
  const before = readFileSync(page);
  await expect(publishResidentEgressPolicy(udid, "block")).rejects.toThrow("another session");
  expect(readFileSync(page)).toEqual(before);
});

test("this process's exclusive reservation permits its own enrollment", async () => {
  writeLaunchState(udid, { launchArgs: [], capabilities: {}, exclusivePid: process.pid });
  expect(await prepareResidentEgress(udid, "passthrough")).toBe(true);
  expect(readLaunchState(udid)!.exclusivePid).toBe(process.pid);
});

test("a confirmed dead reservation does not prevent enrollment", async () => {
  const dead = await recordedDeadBoot();
  writeLaunchState(udid, { launchArgs: [], capabilities: {}, exclusivePid: dead.pid });
  expect(await prepareResidentEgress(udid, "passthrough")).toBe(true);
});

test("unknown reservation visibility fails closed before enrollment", async () => {
  writeLaunchState(udid, { launchArgs: [], capabilities: {}, exclusivePid: process.ppid });
  const original = process.kill;
  const visibility = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === process.ppid) throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    return original.call(process, pid, signal);
  });
  try {
    await expect(prepareResidentEgress(udid, "passthrough")).rejects.toThrow("reservation");
  } finally {
    visibility.mockRestore();
  }
  expect(readLaunchState(udid)!.capabilities).toEqual({});
});

test("malformed reservation metadata fails closed before enrollment", async () => {
  writeFileSync(
    join(state.dir, `launch-${udid}.json`),
    JSON.stringify({
      launchArgs: [],
      capabilities: {},
      exclusivePid: "unknown",
    }),
  );
  await expect(prepareResidentEgress(udid, "passthrough")).rejects.toThrow("reservation");
  expect(readdirSync(state.dir).filter((name) => name.startsWith("egress-"))).toEqual([]);
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
