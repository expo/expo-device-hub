import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { bootDevice } from "../device";
import { armCapabilityLoader, capabilityLoaderPath, childLaunchEnv, releaseSession, releaseSessionSync, removeCapabilityLoader, disarmStaleCapabilityLoader, capabilityConfigPath } from "../launch-manager";
import { writeManagedStartupDylibs, managedStartupDylibs } from "../capability-config";
import { writeLaunchState } from "../launch-state";
import { additionalDylibs } from "../additional-dylibs";
import { startDeviceInProcess } from "../middleware";
import { simctl, simctlSync } from "../simctl";
import { locateProxyDylib } from "../capture/device";
import { freePortAsync, useTempStateDir, withShimsAsync } from "./helpers";

const UDID = "11111111-2222-3333-4444-555555555555";
const bootInsert = [capabilityLoaderPath(), locateProxyDylib()].filter(Boolean).join(":");
const previous = process.env.SERVE_SIM_ADDITIONAL_DYLIBS;
afterEach(() => {
  if (previous === undefined) delete process.env.SERVE_SIM_ADDITIONAL_DYLIBS;
  else process.env.SERVE_SIM_ADDITIONAL_DYLIBS = previous;
});

describe("additional simulator dylibs", () => {
  test("preserve whitespace in caller paths through parsing and getenv readback", async () => {
    const value = "/guard.dylib : /other.dylib ";
    process.env.SERVE_SIM_ADDITIONAL_DYLIBS = `${value}::/guard.dylib `;
    expect(additionalDylibs()).toEqual(["/guard.dylib ", " /other.dylib "]);
    await withShimsAsync({ xcrun: `#!/usr/bin/env node
console.log(${JSON.stringify(value)});
` }, async () => {
      for (const args of [["spawn", UDID, "launchctl", "getenv", "DYLD_INSERT_LIBRARIES"], ["getenv", UDID, "DYLD_INSERT_LIBRARIES"]]) {
        expect(await simctl(args)).toBe(value);
        expect(simctlSync(args)).toBe(value);
      }
      expect(await simctl(["list", "devices"])).toBe(value.trim());
    });
  });

  test.each(["sync", "async", "stale"])("%s cleanup preserves caller collisions and whitespace while removing managed images", async (mode) => {
    const state = useTempStateDir();
    const insert = join(state.dir, "insert");
    const startup = "/capture.dylib";
    const otherLoader = "/caller/libServeSimCapabilityLoader.dylib";
    const caller = [startup, otherLoader, "/guard.dylib "];
    process.env.SERVE_SIM_ADDITIONAL_DYLIBS = caller.join(":");
    writeFileSync(insert, [capabilityLoaderPath(), ...caller, "/managed.dylib"].join(":"));
    writeManagedStartupDylibs(UDID, [startup, "/managed.dylib"]);
    writeLaunchState(UDID, { launchArgs: [], capabilities: {}, sessionPids: [process.pid] });
    try {
      await withShimsAsync({ xcrun: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = ${JSON.stringify(insert)};
if (args[4] === 'getenv' && args[5] === 'DYLD_INSERT_LIBRARIES') console.log(fs.readFileSync(file, 'utf8'));
if (args[4] === 'setenv' && args[5] === 'DYLD_INSERT_LIBRARIES') fs.writeFileSync(file, args[6]);
if (args[4] === 'unsetenv' && args[5] === 'DYLD_INSERT_LIBRARIES') fs.writeFileSync(file, '');
` }, async () => {
        if (mode === "sync") releaseSessionSync(UDID, process.pid, () => {});
        else if (mode === "async") await releaseSession(UDID, process.pid, () => {});
        else await removeCapabilityLoader(UDID);
        expect(readFileSync(insert, "utf8").split(":")).toEqual(caller);
        expect(managedStartupDylibs(UDID)).toEqual([]);
      });
    } finally {
      state.restore();
    }
  });

  test("partial session release preserves caller startup images while clearing their managed ownership", async () => {
    const state = useTempStateDir();
    const insert = join(state.dir, "insert");
    const startup = "/capture.dylib ";
    process.env.SERVE_SIM_ADDITIONAL_DYLIBS = startup;
    writeFileSync(insert, `${capabilityLoaderPath()}:/managed.dylib:${startup}`);
    writeManagedStartupDylibs(UDID, [startup, "/managed.dylib"]);
    writeLaunchState(UDID, { launchArgs: [], capabilities: {
      capture: { name: "capture", scope: "allApps", dylib: startup, loadPhase: "startup", ownerPid: process.pid, bundleId: null },
      camera: { name: "camera", scope: "allApps", dylib: "/camera.dylib", ownerPid: null, bundleId: null },
    } });
    try {
      await withShimsAsync({ xcrun: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = ${JSON.stringify(insert)};
if (args[4] === 'getenv' && args[5] === 'DYLD_INSERT_LIBRARIES') console.log(fs.readFileSync(file, 'utf8'));
if (args[4] === 'setenv' && args[5] === 'DYLD_INSERT_LIBRARIES') fs.writeFileSync(file, args[6]);
` }, async () => {
        releaseSessionSync(UDID, process.pid, () => {});
        expect(readFileSync(insert, "utf8")).toBe(`${capabilityLoaderPath()}:${startup}`);
        expect(managedStartupDylibs(UDID)).toEqual([]);
      });
    } finally {
      state.restore();
    }
  });

  test("a missing caller library with the loader's filename cannot disarm a live session", async () => {
    const state = useTempStateDir();
    const caller = join(state.dir, "missing/libServeSimCapabilityLoader.dylib");
    process.env.SERVE_SIM_ADDITIONAL_DYLIBS = caller;
    writeLaunchState(UDID, { launchArgs: [], capabilities: {}, sessionPids: [process.pid] });
    writeFileSync(capabilityConfigPath(UDID), "live config");
    try {
      await withShimsAsync({ xcrun: `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[4] !== 'getenv') process.exit(1);
console.log(${JSON.stringify(`${caller}:${capabilityLoaderPath()}`)});
` }, async () => {
        await disarmStaleCapabilityLoader(UDID);
        expect(readFileSync(capabilityConfigPath(UDID), "utf8")).toBe("live config");
      });
    } finally {
      state.restore();
    }
  });

  test("reach foreground CLI boot before the boot wait", async () => {
    const state = useTempStateDir();
    const log = join(state.dir, "cli.jsonl");
    process.env.SERVE_SIM_ADDITIONAL_DYLIBS = "/guard.dylib";
    try {
      await withShimsAsync({ xcrun: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, insert: process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES}) + '\\n');
if (args[1] === 'list') console.log(JSON.stringify({devices: {iOS: [{udid: '${UDID}', state: 'Shutdown'}]}}));
if (args[1] === 'bootstatus') process.exit(1);
` }, async () => {
        const child = Bun.spawn(["bun", join(import.meta.dir, "../index.ts"), UDID, "--quiet", "--port", String(await freePortAsync())], {
          env: { ...process.env, DEVELOPER_DIR: state.dir }, stdout: "pipe", stderr: "pipe",
        });
        const timeout = setTimeout(() => child.kill(), 5_000);
        try {
          await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
          expect(await child.exited).toBe(1);
        } finally {
          clearTimeout(timeout);
          child.kill();
          await child.exited;
        }
      });
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const boot = calls.filter(call => ["boot", "bootstatus"].includes(call.args[1]));
      expect(boot.map(call => call.args[1])).toEqual(["boot", "bootstatus"]);
      expect(boot.map(call => call.insert)).toEqual([
        `${bootInsert}:/guard.dylib`, `${bootInsert}:/guard.dylib`,
      ]);
    } finally {
      state.restore();
    }
  });

  test("reach boot and bootstatus through device and middleware startup", async () => {
    const state = useTempStateDir();
    const log = join(state.dir, "calls.jsonl");
    process.env.SERVE_SIM_ADDITIONAL_DYLIBS = "/guard.dylib:/other guard.dylib";
    try {
      await withShimsAsync({ xcrun: `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args: process.argv.slice(2), insert: process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES}) + '\\n');
` }, async () => {
        await bootDevice(UDID);
        expect(await startDeviceInProcess(UDID, 12345, "/")).toBeNull();
        await simctl(["list", "devices", "-j"]);
      });
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(calls.slice(0, 4).map(call => call.args[1])).toEqual(["boot", "bootstatus", "boot", "bootstatus"]);
      for (const call of calls.slice(0, 4)) {
        expect(call.insert).toBe(`${bootInsert}:/guard.dylib:/other guard.dylib`);
      }
      expect(calls[4].insert).toBeUndefined();
    } finally {
      state.restore();
    }
  });

  test("coexist with the loader and foreign inserts, and survive session cleanup", async () => {
    const state = useTempStateDir();
    const insert = join(state.dir, "insert");
    writeFileSync(insert, "/foreign.dylib:/guard.dylib");
    process.env.SERVE_SIM_ADDITIONAL_DYLIBS = "/guard.dylib::/second.dylib:/guard.dylib";
    try {
      await withShimsAsync({ xcrun: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = ${JSON.stringify(insert)};
if (args[4] === 'getenv' && args[5] === 'DYLD_INSERT_LIBRARIES') console.log(fs.readFileSync(file, 'utf8'));
if (args[4] === 'setenv' && args[5] === 'DYLD_INSERT_LIBRARIES') fs.writeFileSync(file, args[6]);
if (args[4] === 'unsetenv' && args[5] === 'DYLD_INSERT_LIBRARIES') fs.writeFileSync(file, '');
` }, async () => {
        await armCapabilityLoader(UDID);
        expect(readFileSync(insert, "utf8").split(":")).toEqual([
          "/foreign.dylib", "/guard.dylib", capabilityLoaderPath(), "/second.dylib",
        ]);
        releaseSessionSync(UDID, process.pid, () => {});
        expect(readFileSync(insert, "utf8").split(":")).toEqual([
          "/foreign.dylib", "/guard.dylib", "/second.dylib",
        ]);
      });
    } finally {
      state.restore();
    }
  });

  test("remain present when a capability supplies an explicit app insert", () => {
    process.env.SERVE_SIM_ADDITIONAL_DYLIBS = "/guard.dylib:/guard.dylib";
    const env = childLaunchEnv("/camera.dylib", { SIMCAM_SHM_NAME: "/shm" });
    expect(env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES!.split(":")).toEqual([
      "/camera.dylib", capabilityLoaderPath(), "/guard.dylib",
    ]);
    expect(env.SIMCTL_CHILD_SIMCAM_SHM_NAME).toBe("/shm");
  });
});
