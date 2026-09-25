import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capabilityConfigPath, managedStartupDylibs } from "../capability-config";
import { enableCapabilities, disableCapability, releaseSessionSync, removeCapabilityLoaderSync, capabilityLoaderPath } from "../launch-manager";
import { installShims, useTempStateDir } from "./helpers";

const UDID = "startup-capabilities-test";
let state: ReturnType<typeof useTempStateDir>;
let shims: ReturnType<typeof installShims>;
let envPath: string;
let failurePath: string;
let dylib: string;

beforeEach(() => {
  state = useTempStateDir();
  envPath = join(state.dir, "env.json");
  failurePath = join(state.dir, "fail-insert");
  dylib = join(state.dir, "startup.dylib");
  writeFileSync(dylib, "");
  writeFileSync(envPath, JSON.stringify({ DYLD_INSERT_LIBRARIES: "/other.dylib" }));
  shims = installShims({ xcrun: `#!/usr/bin/env node
const fs = require('node:fs');
const path = ${JSON.stringify(envPath)};
const failure = ${JSON.stringify(failurePath)};
const env = JSON.parse(fs.readFileSync(path, 'utf8'));
const [,,,, command, name, value] = process.argv.slice(2);
if (name === 'DYLD_INSERT_LIBRARIES' && command !== 'getenv' && fs.existsSync(failure)) {
  fs.unlinkSync(failure); process.exit(1);
}
if (command === 'getenv') process.stdout.write(env[name] || '');
if (command === 'setenv') env[name] = value;
if (command === 'unsetenv') delete env[name];
fs.writeFileSync(path, JSON.stringify(env));
` });
});

afterEach(() => { shims.restore(); state.restore(); });

function env(): Record<string, string> { return JSON.parse(readFileSync(envPath, "utf8")); }

async function enable(path = dylib): Promise<void> {
  await enableCapabilities(UDID, null, [{
    name: "capture", scope: "userApps", loadPhase: "startup", dylib: path,
    env: { SIMNET_PROXY_PORT_FILE: "/capture/port" },
  }], { relaunch: false });
}

test("startup capture uses shared inserts and capability environment", async () => {
  await enable();
  expect(env().DYLD_INSERT_LIBRARIES?.split(":")).toEqual(["/other.dylib", capabilityLoaderPath(), dylib]);
  expect(env().SIMNET_PROXY_PORT_FILE).toBeUndefined();
  expect(readFileSync(capabilityConfigPath(UDID), "utf8")).toBe(`startup\tuser\t${dylib}\tSIMNET_PROXY_PORT_FILE=/capture/port\t0\n`);
  await disableCapability(UDID, null, "capture", { relaunch: false });
  expect(env().DYLD_INSERT_LIBRARIES).not.toContain(dylib);
  expect(managedStartupDylibs(UDID)).toEqual([]);
});

test("hybrid capture keeps its early insert and publishes a deferred load for running apps", async () => {
  await enableCapabilities(UDID, null, [{
    name: "networkCapture", scope: "userApps", loadPhase: "startupAndDeferred", dylib,
    env: { SIMNET_PROXY_PORT_FILE: "/capture/port" },
  }], { relaunch: false });
  const line = `user\t${dylib}\tSIMNET_PROXY_PORT_FILE=/capture/port\t0`;
  expect(readFileSync(capabilityConfigPath(UDID), "utf8")).toBe(`startup\t${line}\n${line}\n`);
  expect(env().DYLD_INSERT_LIBRARIES?.split(":")).toEqual(["/other.dylib", capabilityLoaderPath(), dylib]);
  await disableCapability(UDID, null, "networkCapture", { relaunch: false });
  expect(env().DYLD_INSERT_LIBRARIES).not.toContain(dylib);
});

test("invalid startup paths are refused before publication", async () => {
  for (const path of ["relative.dylib", "/bad:path.dylib", "/missing/startup.dylib"]) {
    await expect(enable(path)).rejects.toThrow();
    expect(env()).toEqual({ DYLD_INSERT_LIBRARIES: "/other.dylib" });
    expect(existsSync(capabilityConfigPath(UDID))).toBe(false);
  }
});

test("failed publication restores actual config and launchd values", async () => {
  const previous = "# previous config retained for cleanup\n";
  writeFileSync(capabilityConfigPath(UDID), previous);
  writeFileSync(failurePath, "");
  await expect(enable()).rejects.toThrow();
  expect(readFileSync(capabilityConfigPath(UDID), "utf8")).toBe(previous);
  expect(env()).toEqual({ DYLD_INSERT_LIBRARIES: "/other.dylib" });
  expect(managedStartupDylibs(UDID)).toEqual([]);
});

test("failed final disarm retains ownership until a successful retry", async () => {
  await enable();
  writeFileSync(failurePath, "");
  removeCapabilityLoaderSync(UDID);
  expect(managedStartupDylibs(UDID)).toEqual([dylib]);
  expect(env().DYLD_INSERT_LIBRARIES).toContain(dylib);
  removeCapabilityLoaderSync(UDID);
  expect(env()).toEqual({ DYLD_INSERT_LIBRARIES: "/other.dylib" });
  expect(managedStartupDylibs(UDID)).toEqual([]);
});

test("failed owner release can retry while another capability remains", async () => {
  await enableCapabilities(UDID, null, [{ name: "camera", scope: "allApps", dylib: "/camera.dylib" }], { relaunch: false, ownerPid: null });
  await enable();
  writeFileSync(failurePath, "");
  expect(() => releaseSessionSync(UDID, process.pid, () => {})).toThrow();
  expect(managedStartupDylibs(UDID)).toEqual([dylib]);
  releaseSessionSync(UDID, process.pid, () => {});
  expect(env().DYLD_INSERT_LIBRARIES).not.toContain(dylib);
  expect(env().DYLD_INSERT_LIBRARIES).toContain(capabilityLoaderPath());
  expect(readFileSync(capabilityConfigPath(UDID), "utf8")).toContain("camera.dylib");
  expect(managedStartupDylibs(UDID)).toEqual([]);
});
