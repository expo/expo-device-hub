import { afterEach, beforeEach, expect, test } from "bun:test";

import { join } from "node:path";

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import {
  formatCapabilityConfig,
  capabilityConfigPath,
  writeManagedStartupDylibs,
} from "../capability-config";

import { readLaunchState, writeLaunchState, type RecordedCapability } from "../launch-state";

import {
  disableCapability,
  enableCapabilities,
  releaseLaunchState,
  removeCapabilityLoader,
  removeCapabilityLoaderSync,
  isCapabilityArmed,
  disarmStaleCapabilityLoader,
  armCapabilityLoader,
} from "../launch-manager";

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

test("resident arming rejects a missing pinned loader without changing enrollment", async () => {
  const guard = enrollment();
  writeLaunchState(udid, { launchArgs: [], capabilities: { egressGuard: guard } });
  const config = capabilityConfigPath(udid);
  writeFileSync(config, formatCapabilityConfig({ egressGuard: guard }));
  writeManagedStartupDylibs(udid, [guard.dylib]);
  const before = readFileSync(config);
  await expect(armCapabilityLoader(udid)).rejects.toThrow("Capability loader not found");
  expect(readLaunchState(udid)?.capabilities.egressGuard).toEqual(guard);
  expect(readFileSync(config)).toEqual(before);
});

test("a missing resident loader rejects stale cleanup without changing enrollment", async () => {
  const guard = enrollment();
  writeLaunchState(udid, { launchArgs: [], capabilities: { egressGuard: guard } });
  const config = capabilityConfigPath(udid);
  writeFileSync(config, formatCapabilityConfig({ egressGuard: guard }));
  const missing = join(state.dir, "libServeSimCapabilityLoader.dylib");
  writeManagedStartupDylibs(udid, [guard.dylib]);
  const originalFiles = Object.fromEntries(
    (await import("node:fs"))
      .readdirSync(state.dir)
      .map((name) => [name, readFileSync(join(state.dir, name))]),
  );
  const calls = join(state.dir, "calls");
  await withShimsAsync(
    {
      xcrun: `#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args.includes('getenv')) console.log(${JSON.stringify(`${missing}:${guard.dylib}:/foreign/image.dylib`)});
else process.exit(99);
`,
    },
    async () => {
      await expect(disarmStaleCapabilityLoader(udid)).rejects.toThrow(
        "missing resident capability loader",
      );
    },
  );
  expect(readFileSync(calls, "utf8")).not.toMatch(/setenv|unsetenv/);
  for (const [name, bytes] of Object.entries(originalFiles))
    expect(readFileSync(join(state.dir, name))).toEqual(bytes);
});

test("all-process records are startup-only and cannot defer initialization", () => {
  const guard = enrollment();
  expect(formatCapabilityConfig({ egressGuard: guard })).toBe(
    `startup\tprocess\t${guard.dylib}\tSERVE_SIM_EGRESS_POLICY_FILE=${guard.env!.SERVE_SIM_EGRESS_POLICY_FILE}\t0\n`,
  );
  for (const loadPhase of [undefined, "deferred", "startupAndDeferred"] as const) {
    expect(() => formatCapabilityConfig({ egressGuard: { ...guard, loadPhase } })).toThrow(
      "startup-only",
    );
  }
});

test("session release retains enrollment and its startup config record for later helpers", () => {
  const guard = enrollment();
  writeLaunchState(udid, {
    launchArgs: [],
    sessionPids: [process.pid],
    capabilities: {
      egressGuard: guard,
      camera: {
        ...guard,
        name: "camera",
        scope: "userApps",
        resident: undefined,
        ownerPid: process.pid,
      },
    },
  });
  expect(releaseLaunchState(udid, process.pid)).toBe(true);
  expect(readLaunchState(udid)?.capabilities).toEqual({ egressGuard: guard });
  expect(readFileSync(capabilityConfigPath(udid), "utf8")).toBe(
    formatCapabilityConfig({ egressGuard: guard }),
  );
});

test("generic capability disable cannot withdraw resident enrollment", async () => {
  const guard = enrollment();
  writeLaunchState(udid, { launchArgs: [], capabilities: { egressGuard: guard } });
  await expect(disableCapability(udid, null, "egressGuard", { relaunch: false })).rejects.toThrow(
    "policy",
  );
  expect(readLaunchState(udid)?.capabilities.egressGuard).toEqual(guard);
});

test("malformed resident metadata cannot be silently discarded as a stale app capability", () => {
  const guard = enrollment();
  writeFileSync(
    join(state.dir, `launch-${udid}.json`),
    JSON.stringify({
      launchArgs: [],
      capabilities: { egressGuard: { ...guard, resident: { boot: { pid: 123 } } } },
    }),
  );
  expect(() => readLaunchState(udid)).toThrow("resident");
});

for (const [field, invalid] of [
  ["name", { name: "camera" }],
  ["scope", { scope: "allApps" }],
  ["loadPhase", { loadPhase: "deferred" }],
  ["ownerPid", { ownerPid: 123 }],
  ["dylib", { dylib: 123 }],
  ["env", { env: { SERVE_SIM_EGRESS_POLICY_FILE: 123 } }],
  ["resident.boot", { resident: { boot: { pid: 0 }, warmupPolicy: "block" } }],
  ["resident.warmupPolicy", { resident: { boot: null, warmupPolicy: "unknown" } }],
  ["resident.assets", { resident: { boot: null, warmupPolicy: "block", assets: { hashes: 1 } } }],
] as const) {
  test(`resident parsing identifies invalid ${field} without incidental TypeErrors`, () => {
    const file = join(state.dir, `launch-${udid}.json`);
    writeFileSync(
      file,
      JSON.stringify({ capabilities: { egressGuard: { ...enrollment(), ...invalid } } }),
    );
    expect(() => readLaunchState(udid)).toThrow(file);
    expect(() => readLaunchState(udid)).toThrow(field);
  });
}

test("pending enrollment and camera's owner-list encoding survive generic state round trips", () => {
  const guard = {
    ...enrollment(),
    ownerPid: undefined,
    ownerPids: [],
    resident: { boot: null, warmupPolicy: "block" },
  };
  const file = join(state.dir, `launch-${udid}.json`);
  writeFileSync(file, JSON.stringify({ launchArgs: [], capabilities: { egressGuard: guard } }));
  const first = readLaunchState(udid)!;
  writeLaunchState(udid, first);
  expect(readLaunchState(udid)).toEqual(first);
  expect(first.capabilities.egressGuard?.resident?.boot).toBeNull();
});

test("ordinary config publication preserves the resident record unchanged", () => {
  const guard = enrollment();
  writeLaunchState(udid, { launchArgs: [], capabilities: { egressGuard: guard } });
  const current = readLaunchState(udid)!;
  const camera: RecordedCapability = {
    name: "camera",
    scope: "userApps",
    dylib: "/camera.dylib",
    bundleId: null,
    ownerPid: process.pid,
  };
  writeLaunchState(udid, { ...current, capabilities: { ...current.capabilities, camera } });
  const contents = formatCapabilityConfig(readLaunchState(udid)!.capabilities);
  expect(contents).toContain(formatCapabilityConfig({ egressGuard: guard }));
  expect(contents).toContain("user\t/camera.dylib");
});

for (const broken of ["missing", "malformed", "null-record"]) {
  test(`ordinary disable preserves resident config when launch metadata is ${broken}`, async () => {
    const guard = enrollment();
    const config = formatCapabilityConfig({ egressGuard: guard });
    writeManagedStartupDylibs(udid, [guard.dylib]);
    writeFileSync(capabilityConfigPath(udid), config);
    const launchPath = join(state.dir, `launch-${udid}.json`);
    if (broken === "missing") rmSync(launchPath, { force: true });
    else
      writeFileSync(
        launchPath,
        broken === "malformed"
          ? "{"
          : JSON.stringify({ launchArgs: [], capabilities: { egressGuard: null } }),
      );
    const before = existsSync(launchPath) ? readFileSync(launchPath, "utf8") : null;
    const nativeLog = join(state.dir, "native-calls");
    await withShimsAsync(
      {
        xcrun: `#!/bin/sh
echo called >> '${nativeLog}'
if [ "$5" = "getenv" ] && [ "$6" = "DYLD_INSERT_LIBRARIES" ]; then echo '${guard.dylib}'; fi
`,
      },
      async () => {
        await expect(disableCapability(udid, null, "camera", { relaunch: false })).rejects.toThrow(
          "resident",
        );
        await expect(
          enableCapabilities(
            udid,
            null,
            [{ name: "camera", scope: "userApps", dylib: "/camera.dylib" }],
            { relaunch: false },
          ),
        ).rejects.toThrow("resident");
      },
    );
    expect(readFileSync(capabilityConfigPath(udid), "utf8")).toBe(config);
    expect(existsSync(launchPath) ? readFileSync(launchPath, "utf8") : null).toBe(before);
    expect(existsSync(nativeLog)).toBe(false);
  });
}

test("generic first enrollment refuses late insertion before changing an ordinary config", async () => {
  const guard = enrollment();
  const config = "user\t/camera.dylib\t\t0\n";
  writeFileSync(capabilityConfigPath(udid), config);
  const nativeLog = join(state.dir, "native-calls");
  await withShimsAsync(
    { xcrun: `#!/bin/sh\necho called >> '${nativeLog}'\nexit 99\n` },
    async () => {
      await expect(
        enableCapabilities(udid, null, [guard], { ownerPid: null, relaunch: false }),
      ).rejects.toThrow("preboot");
    },
  );
  expect(readFileSync(capabilityConfigPath(udid), "utf8")).toBe(config);
  expect(existsSync(join(state.dir, `launch-${udid}.json`))).toBe(false);
  expect(existsSync(nativeLog)).toBe(false);
});

for (const sync of [false, true]) {
  test(`config-only resident evidence prevents ${sync ? "sync" : "async"} loader removal`, async () => {
    const guard = enrollment();
    const original = formatCapabilityConfig({ egressGuard: guard });
    writeFileSync(capabilityConfigPath(udid), original);
    const nativeLog = join(state.dir, "native-calls");
    await withShimsAsync(
      {
        xcrun: `#!/bin/sh\necho called >> '${nativeLog}'\nif [ "$5" = "getenv" ]; then echo '/loader/libServeSimCapabilityLoader.dylib:${guard.dylib}'; fi\n`,
      },
      async () => {
        if (sync) expect(() => removeCapabilityLoaderSync(udid)).toThrow("resident");
        else await expect(removeCapabilityLoader(udid)).rejects.toThrow("resident");
      },
    );
    expect(readFileSync(capabilityConfigPath(udid), "utf8")).toBe(original);
    expect(existsSync(nativeLog)).toBe(false);
  });
}

test("capability health accepts the boot's pinned resident loader", async () => {
  const guard = enrollment();
  const capture: RecordedCapability = {
    name: "networkCapture",
    scope: "userApps",
    loadPhase: "startup",
    dylib: "/capture.dylib",
    ownerPid: process.pid,
    bundleId: null,
  };
  writeLaunchState(udid, {
    launchArgs: [],
    capabilities: { egressGuard: guard, networkCapture: capture },
  });
  writeFileSync(
    capabilityConfigPath(udid),
    formatCapabilityConfig({ egressGuard: guard, networkCapture: capture }),
  );
  const insert = [
    join(state.dir, "libServeSimCapabilityLoader.dylib"),
    guard.dylib,
    capture.dylib,
  ].join(":");
  expect(
    await isCapabilityArmed(udid, "networkCapture", {}, async (args) =>
      args.at(-1) === "DYLD_INSERT_LIBRARIES" ? insert : capabilityConfigPath(udid),
    ),
  ).toBe(true);
});
