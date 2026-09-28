import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capabilityConfigPath, managedStartupDylibs, writeManagedStartupDylibs } from "../capability-config";
import { enableCapabilities, disableCapability, disarmStaleCapabilityLoader, releaseSessionSync, removeCapabilityLoaderSync, capabilityLoaderPath } from "../launch-manager";
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
  // failure + '.watch' names a file to copy, recording what a running app's loader could read then.
  if (fs.existsSync(failure + '.watch')) {
    const watched = fs.readFileSync(failure + '.watch', 'utf8');
    fs.writeFileSync(failure + '.seen', fs.existsSync(watched) ? fs.readFileSync(watched, 'utf8') : '');
  }
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

test("a first commit that fails reports its own error, not a failed rollback", async () => {
  // No config before, and the commit cannot write its temp file, so the config was never created.
  mkdirSync(`${capabilityConfigPath(UDID)}.${process.pid}.tmp`, { recursive: true });
  try {
    const error = await enable().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain("Could not restore capability launch state");
    expect(existsSync(capabilityConfigPath(UDID))).toBe(false);
    expect(env()).toEqual({ DYLD_INSERT_LIBRARIES: "/other.dylib" });
  } finally {
    rmSync(`${capabilityConfigPath(UDID)}.${process.pid}.tmp`, { recursive: true, force: true });
  }
});

test("stale cleanup drops a missing startup image while the loader stays", async () => {
  const loader = join(state.dir, "libServeSimCapabilityLoader.dylib");
  writeFileSync(loader, "");
  const live = join(state.dir, "live-startup.dylib");
  writeFileSync(live, "");
  const gone = join(state.dir, "removed-startup.dylib");
  writeFileSync(envPath, JSON.stringify({ DYLD_INSERT_LIBRARIES: ["/other.dylib", loader, live, gone].join(":") }));
  writeManagedStartupDylibs(UDID, [live, gone]);
  // A live session owns the device, so only the missing image may go.
  writeFileSync(join(state.dir, `launch-${UDID}.json`), JSON.stringify({ launchArgs: [], capabilities: {}, sessionPids: [process.pid] }));

  await disarmStaleCapabilityLoader(UDID);

  // Only the missing image goes; the loader, the live image, and the other tool's insert stay.
  expect(env().DYLD_INSERT_LIBRARIES).toBe(["/other.dylib", loader, live].join(":"));
  expect(managedStartupDylibs(UDID)).toEqual([live]);
});

test("stale cleanup clears the inserts of a session that died without tearing down", async () => {
  const loader = join(state.dir, "libServeSimCapabilityLoader.dylib");
  writeFileSync(loader, "");
  const image = join(state.dir, "capture-startup.dylib");
  writeFileSync(image, "");
  writeFileSync(envPath, JSON.stringify({ DYLD_INSERT_LIBRARIES: ["/other.dylib", loader, image].join(":") }));
  writeManagedStartupDylibs(UDID, [image]);
  // The session that armed it is gone: its pid no longer runs.
  writeFileSync(join(state.dir, `launch-${UDID}.json`), JSON.stringify({ launchArgs: [], capabilities: {}, sessionPids: [2 ** 22 + 17] }));

  await disarmStaleCapabilityLoader(UDID);

  expect(env().DYLD_INSERT_LIBRARIES).toBe("/other.dylib");
  expect(managedStartupDylibs(UDID)).toEqual([]);
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

test("a failed publication never shows running apps its deferred load", async () => {
  const previous = "# previous config retained for cleanup\n";
  writeFileSync(capabilityConfigPath(UDID), previous);
  writeFileSync(failurePath, "");
  writeFileSync(`${failurePath}.watch`, capabilityConfigPath(UDID));
  await expect(enableCapabilities(UDID, null, [{
    name: "networkCapture", scope: "userApps", loadPhase: "startupAndDeferred", dylib,
    env: { SIMNET_PROXY_PORT_FILE: "/capture/port" },
  }], { relaunch: false })).rejects.toThrow();
  expect(readFileSync(`${failurePath}.seen`, "utf8")).not.toContain(dylib);
  expect(readFileSync(capabilityConfigPath(UDID), "utf8")).toBe(previous);
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
