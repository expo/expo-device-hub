import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capabilityConfigPath, formatCapabilityConfig } from "../../capability-config";
import { writeLaunchState } from "../../launch-state";
import type { ResidentEgressRecord } from "../../resident-egress-state";
import { simctlRaw, simctlSync } from "../../simctl";
import { useTempStateDir } from "../helpers";

const udid = "ABCDEF12-1234-4ABC-8123-ABCDEF123456";
const bootCommands = [
  ["boot", udid],
  ["bootstatus", udid, "-b"],
  ["bootstatus", udid, "--boot"],
  ["bootstatus", udid, "-db"],
];
let state: ReturnType<typeof useTempStateDir>;
let originalEnv: NodeJS.ProcessEnv;
let guard: ResidentEgressRecord;
let log: string;

beforeEach(() => {
  originalEnv = { ...process.env };
  state = useTempStateDir();
  log = join(state.dir, "calls.jsonl");
  const shim = join(state.dir, "xcrun");
  copyFileSync(new URL("./resident-boot-xcrun.cjs", import.meta.url), shim);
  chmodSync(shim, 0o755);
  process.env.PATH = `${state.dir}:${process.env.PATH}`;
  process.env.EGRESS_BOOT_TEST_LOG = log;
  delete process.env.SERVE_SIM_ADDITIONAL_DYLIBS;
  delete process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES;
  delete process.env.SIMCTL_CHILD_SERVE_SIM_CAPABILITIES_CONFIG;
  guard = {
    name: "egressGuard",
    dylib: join(state.dir, "libServeSimEgressGuard.dylib"),
    env: { SERVE_SIM_EGRESS_POLICY_FILE: join(state.dir, "policy") },
    scope: "allProcesses",
    loadPhase: "startup",
    bundleId: null,
    ownerPid: null,
    resident: { boot: { pid: 123, startedAt: "1720000000:123456" }, warmupPolicy: "block" },
  };
});

afterEach(() => {
  state.restore();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

function enroll() {
  writeLaunchState(udid, { launchArgs: [], capabilities: { egressGuard: guard } });
  writeFileSync(capabilityConfigPath(udid), formatCapabilityConfig({ egressGuard: guard }));
}

for (const sync of [false, true]) {
  const invoke = async (args: string[]) => (sync ? simctlSync(args) : simctlRaw(args));
  const label = sync ? "sync" : "async";

  test(`${label} bound enrollment rejects every boot-capable command before spawn`, async () => {
    enroll();
    const config = readFileSync(capabilityConfigPath(udid));
    const metadata = readFileSync(join(state.dir, `launch-${udid}.json`));
    for (const args of bootCommands) {
      await expect(invoke(args)).rejects.toThrow("previous page cannot be reused");
      expect(existsSync(log)).toBe(false);
    }
    expect(readFileSync(capabilityConfigPath(udid))).toEqual(config);
    expect(readFileSync(join(state.dir, `launch-${udid}.json`))).toEqual(metadata);
  });

  test(`${label} pending enrollment passes pinned images and config into initial boot`, async () => {
    guard.resident.boot = null;
    enroll();
    for (const args of bootCommands) expect((await invoke(args)).trim()).toBe("shim-output");
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(bootCommands.length);
    expect(calls.map((call) => call.args)).toEqual(bootCommands.map((args) => ["simctl", ...args]));
    for (const call of calls) {
      expect(call.insert.split(":")).toEqual(
        expect.arrayContaining([join(state.dir, "libServeSimCapabilityLoader.dylib"), guard.dylib]),
      );
      expect(call.config).toBe(capabilityConfigPath(udid));
    }
  });

  test(`${label} bound enrollment allows non-booting readiness`, async () => {
    enroll();
    const args = ["bootstatus", udid];
    expect((await invoke(args)).trim()).toBe("shim-output");
    expect(JSON.parse(readFileSync(log, "utf8")).args).toEqual(["simctl", ...args]);
  });
}
