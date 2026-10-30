import { afterEach, beforeEach, expect, test } from "bun:test";

import { join } from "node:path";

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { formatCapabilityConfig, capabilityConfigPath } from "../capability-config";

import { readLaunchState, writeLaunchState, type RecordedCapability } from "../launch-state";

import { useTempStateDir, withShimsAsync } from "./helpers";

let state: ReturnType<typeof useTempStateDir>;

const udid = "11111111-1111-4111-8111-111111111111";

function enrollment(): RecordedCapability {
  return {
    name: "egressGuard",
    dylib: join(state.dir, "libServeSimEgressGuard.dylib"),
    env: { SERVE_SIM_EGRESS_POLICY_FILE: join(state.dir, "policy") },
    scope: "allProcesses",
    loadPhase: "startup",
    bundleId: null,
    ownerPid: null,
    resident: { boot: { pid: 123, startedAt: "1720000000:123456" }, warmupPolicy: "passthrough" },
  };
}

beforeEach(() => {
  state = useTempStateDir();
});

afterEach(() => state.restore());

test("direct shutdown refuses resident enrollment before any device command", async () => {
  const guard = enrollment();
  writeLaunchState(udid, { launchArgs: [], capabilities: { egressGuard: guard } });
  const log = join(state.dir, "shutdown-calls");
  const { shutdownDevice } = await import("../device");
  await withShimsAsync({ xcrun: `#!/bin/sh\necho called > '${log}'\nexit 99\n` }, async () => {
    await expect(shutdownDevice(udid)).rejects.toThrow("resident egress");
  });
  expect(existsSync(log)).toBe(false);
  expect(readLaunchState(udid)?.capabilities.egressGuard).toEqual(guard);
});

test("middleware cannot boot using a previous resident enrollment", async () => {
  const guard = enrollment();
  writeLaunchState(udid, { launchArgs: [], capabilities: { egressGuard: guard } });
  writeFileSync(capabilityConfigPath(udid), formatCapabilityConfig({ egressGuard: guard }));
  const nativeLog = join(state.dir, "native-calls");
  const { startDeviceInProcess } = await import("../middleware");
  await withShimsAsync(
    { xcrun: `#!/bin/sh\necho called >> '${nativeLog}'\nexit 42\n` },
    async () => {
      await expect(startDeviceInProcess(udid, 12345, "/")).rejects.toThrow(
        "resident egress enrollment",
      );
    },
  );
  expect(existsSync(nativeLog)).toBe(false);
  expect(readFileSync(capabilityConfigPath(udid), "utf8")).toContain(
    guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!,
  );
});

test("a lowercase UDID cannot bypass old-boot enrollment protection", async () => {
  const device = "ABCDEF12-1234-4ABC-8123-ABCDEF123456";
  writeLaunchState(device, { launchArgs: [], capabilities: { egressGuard: enrollment() } });
  const { simulatorBootEnv } = await import("../additional-dylibs");
  expect(() => simulatorBootEnv(device.toLowerCase(), true)).toThrow(
    "previous page cannot be reused",
  );
});

for (const sync of [false, true]) {
  test(`boot-capable ${sync ? "sync" : "async"} bootstatus cannot reuse a bound page`, async () => {
    const guard = enrollment();
    writeLaunchState(udid, { launchArgs: [], capabilities: { egressGuard: guard } });
    writeFileSync(capabilityConfigPath(udid), formatCapabilityConfig({ egressGuard: guard }));
    const log = join(state.dir, "native-calls");
    const { simctl, simctlSync } = await import("../simctl");
    await withShimsAsync({ xcrun: `#!/bin/sh\necho called >> '${log}'\n` }, async () => {
      if (sync)
        expect(() => simctlSync(["bootstatus", udid, "-b"])).toThrow(
          "previous page cannot be reused",
        );
      else
        await expect(simctl(["bootstatus", udid, "-b"])).rejects.toThrow(
          "previous page cannot be reused",
        );
    });
    expect(existsSync(log)).toBe(false);
  });
}

test("shared lifecycle refuses resident retirement before withdrawing state", async () => {
  const guard = enrollment();
  writeLaunchState(udid, { launchArgs: [], capabilities: { egressGuard: guard } });
  const { stopDeviceInProcess, retireDevicesInBackground } = await import("../device-lifecycle");
  const { writeServeSimState, inProcessServeSimState, stateFileForDevice } =
    await import("../state");
  writeServeSimState(inProcessServeSimState(udid, 3200));
  const prepared = new Set([udid]);
  const original = readFileSync(stateFileForDevice(udid), "utf8");
  await expect(stopDeviceInProcess(udid, process.pid)).rejects.toThrow(
    "Simulator shutdown is unavailable while resident egress is enrolled",
  );
  expect(() => retireDevicesInBackground([udid], process.pid, prepared)).toThrow(
    "Simulator retirement is unavailable while resident egress is enrolled",
  );
  expect(prepared.has(udid)).toBe(true);
  expect(readFileSync(stateFileForDevice(udid), "utf8")).toBe(original);
  expect(readLaunchState(udid)?.capabilities.egressGuard).toEqual(guard);
});

for (const alreadyPrepared of [false, true])
  test(`preparation preserves resident policy (previously prepared: ${alreadyPrepared})`, async () => {
    writeLaunchState(udid, { launchArgs: [], capabilities: { egressGuard: enrollment() } });
    const { prepareDeviceOnce } = await import("../device-lifecycle");
    let prepared = false;
    await expect(
      prepareDeviceOnce(udid, new Set(alreadyPrepared ? [udid] : []), async () => {
        prepared = true;
      }),
    ).rejects.toThrow("Device preparation is unavailable while resident egress is enrolled");
    expect(prepared).toBe(false);
  });
