import { createCaptureRuntime } from "../capture/runtime";
import { registerCapability, clearRegisteredCapabilities } from "../capabilities";
import { applyDefaultCapabilities, CapabilityRollbackError, setCapabilityEnabled } from "../launch-manager";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capabilityConfigPath, managedStartupDylibs } from "../capability-config";
import { configureCapability, enableCapabilities, disableCapability, releaseSessionSync, removeCapabilityLoaderSync, capabilityLoaderPath } from "../launch-manager";
import { installShims, useTempStateDir } from "./helpers";
import { readLaunchState } from "../launch-state";

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
  const remaining = Number(fs.readFileSync(failure, 'utf8')) || 1;
  if (remaining > 1) {
    fs.writeFileSync(failure, String(remaining - 1));
    if (command === 'setenv') { env[name] = value; fs.writeFileSync(path, JSON.stringify(env)); }
  } else fs.unlinkSync(failure);
  process.exit(1);
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


test("capability resources stop only after startup insertion is removed", async () => {
  let stopped = false;
  const definition = {
    name: "networkCapture", scope: "userApps" as const, loadPhase: "startup" as const,
    defaultEnabled: false,
    async setEnabled({ enabled }: { enabled: boolean }) {
      if (enabled) return { dylib };
      expect(env().DYLD_INSERT_LIBRARIES).not.toContain(dylib);
      stopped = true;
      return null;
    },
  };
  await configureCapability(UDID, definition, { enabled: true, relaunch: false });
  await configureCapability(UDID, definition, { enabled: false });
  expect(stopped).toBe(true);
});

test("failed capability publication closes its prepared resources after rollback", async () => {
  let stopped = false;
  let activated = false;
  writeFileSync(failurePath, "");
  await expect(configureCapability(UDID, {
    name: "networkCapture", scope: "userApps", loadPhase: "startup", defaultEnabled: false,
    async setEnabled({ enabled }) {
      if (!enabled) return null;
      return {
        dylib,
        committed() { activated = true; },
        async rollback() {
          expect(env().DYLD_INSERT_LIBRARIES).not.toContain(dylib);
          stopped = true;
        },
      };
    },
  }, { enabled: true, relaunch: false })).rejects.toThrow();
  expect(stopped).toBe(true);
  expect(activated).toBe(false);
});

test("a capability that fails after publication is withdrawn before its resources stop", async () => {
  let stopped = false;
  await expect(configureCapability(UDID, {
    name: "networkCapture", scope: "userApps", loadPhase: "startup", defaultEnabled: false,
    async setEnabled({ enabled }) {
      if (!enabled) return null;
      return {
        dylib,
        committed() { throw new Error("proxy exited during publication"); },
        async rollback() {
          expect(env().DYLD_INSERT_LIBRARIES).not.toContain(dylib);
          stopped = true;
        },
      };
    },
  }, { enabled: true, relaunch: false })).rejects.toThrow("proxy exited during publication");
  expect(env().DYLD_INSERT_LIBRARIES).not.toContain(dylib);
  expect(stopped).toBe(true);
});

test("a failed first publication leaves no loader or launch state behind", async () => {
  expect(readLaunchState(UDID)).toBeNull();
  await expect(configureCapability(UDID, {
    name: "networkCapture", scope: "userApps", loadPhase: "startup", defaultEnabled: false,
    async setEnabled({ enabled }) {
      return enabled ? { dylib, committed() { throw new Error("proxy exited during publication"); } } : null;
    },
  }, { enabled: true, relaunch: false })).rejects.toThrow("proxy exited during publication");
  expect(env()).toEqual({ DYLD_INSERT_LIBRARIES: "/other.dylib" });
  expect(readLaunchState(UDID)).toBeNull();
  expect(existsSync(capabilityConfigPath(UDID))).toBe(false);
});

test("a failed capability restores the owner it replaced", async () => {
  const definition = (committed: () => void) => ({
    name: "shared", scope: "userApps" as const, loadPhase: "startup" as const, defaultEnabled: false,
    async setEnabled({ enabled }: { enabled: boolean }) {
      return enabled ? { dylib, committed } : null;
    },
  });
  await configureCapability(UDID, definition(() => {}), { enabled: true, relaunch: false, ownerPid: process.ppid });
  await expect(configureCapability(UDID, definition(() => { throw new Error("proxy exited"); }), {
    enabled: true, relaunch: false,
  })).rejects.toThrow("proxy exited");
  expect(readLaunchState(UDID)?.capabilities.shared?.ownerPid).toBe(process.ppid);
  expect(env().DYLD_INSERT_LIBRARIES).toContain(dylib);
});

test("failed capability removal keeps resources alive for a retry", async () => {
  let stopped = false;
  const definition = {
    name: "networkCapture", scope: "userApps" as const, loadPhase: "startup" as const,
    defaultEnabled: false,
    async setEnabled({ enabled }: { enabled: boolean }) {
      if (enabled) return { dylib };
      stopped = true;
      return null;
    },
  };
  await configureCapability(UDID, definition, { enabled: true, relaunch: false });
  writeFileSync(failurePath, "");
  await expect(configureCapability(UDID, definition, { enabled: false })).rejects.toThrow();
  expect(stopped).toBe(false);
  expect(env().DYLD_INSERT_LIBRARIES).toContain(dylib);
  await configureCapability(UDID, definition, { enabled: false });
  expect(stopped).toBe(true);
});


test("registry capture prepares, publishes, reuses, and removes the same runtime session", async () => {
  let starts = 0;
  let closes = 0;
  const runtime = createCaptureRuntime({
    dylib: () => dylib,
    trustCa: async () => {},
    startProxy: async () => {
      starts++;
      return {
        address: "127.0.0.1:1234", portFile: "/capture/port", caPem: async () => "CA",
        close: async () => { closes++; },
      };
    },
  });
  registerCapability(runtime.capability);
  try {
    await setCapabilityEnabled(UDID, "networkCapture", { enabled: true, relaunch: false });
    expect(runtime.metaFor(UDID).attachment).toBe("capturing");
    expect(env().SIMNET_PROXY_PORT_FILE).toBeUndefined();
    expect(env().DYLD_INSERT_LIBRARIES).toContain(dylib);
    writeFileSync(failurePath, "");
    await expect(setCapabilityEnabled(UDID, "networkCapture", { enabled: true, relaunch: false })).rejects.toThrow();
    expect(starts).toBe(1);
    expect(closes).toBe(0);
    await setCapabilityEnabled(UDID, "networkCapture", { enabled: false });
    expect(closes).toBe(1);
    expect(runtime.metaFor(UDID).attachment).toBe("not-enabled");
    expect(env().DYLD_INSERT_LIBRARIES).not.toContain(dylib);
  } finally {
    await runtime.disableAll();
    clearRegisteredCapabilities();
  }
});


function captureHarness(close: () => Promise<void> = async () => {}) {
  return createCaptureRuntime({
    dylib: () => dylib, trustCa: async () => {},
    startProxy: async () => ({
      address: "127.0.0.1:1234", portFile: "/capture/port", caPem: async () => "CA", close,
    }),
  });
}

test("uncertain initial publication can be disabled without leaving a startup insert", async () => {
  let closed = false;
  const runtime = captureHarness(async () => {
    expect(env().DYLD_INSERT_LIBRARIES).not.toContain(dylib);
    closed = true;
  });
  writeFileSync(failurePath, "2");
  await expect(runtime.enableForDevice(UDID)).rejects.toThrow("restore capability launch state");
  expect(closed).toBe(false);
  expect(env().DYLD_INSERT_LIBRARIES).toContain(dylib);
  await runtime.disableForDevice(UDID);
  expect(closed).toBe(true);
  expect(managedStartupDylibs(UDID)).toEqual([]);
});

test("registry publication failure reports failed capture metadata", async () => {
  const runtime = captureHarness();
  writeFileSync(failurePath, "");
  await expect(configureCapability(UDID, runtime.capability, { enabled: true, relaunch: false })).rejects.toThrow();
  expect(runtime.metaFor(UDID).attachment).toBe("failed");
  expect(runtime.metaFor(UDID).proxyAddress).toBeNull();
  await runtime.disableAll();
});

test("runtime enable waits for a registry disable that is closing its proxy", async () => {
  let closing!: () => void;
  let finishClose!: () => void;
  const closeStarted = new Promise<void>((resolve) => { closing = resolve; });
  const closeFinished = new Promise<void>((resolve) => { finishClose = resolve; });
  const runtime = captureHarness(async () => { closing(); await closeFinished; });
  await runtime.enableForDevice(UDID);
  const disable = configureCapability(UDID, runtime.capability, { enabled: false });
  await closeStarted;
  const enable = runtime.enableForDevice(UDID);
  finishClose();
  await disable;
  expect((await enable).attachment).toBe("capturing");
  expect(env().DYLD_INSERT_LIBRARIES).toContain(dylib);
  await runtime.disableAll();
});


test("capture refuses a foreign owner and leaves its registration on local cleanup", async () => {
  const runtime = captureHarness();
  await enableCapabilities(UDID, null, [{
    name: "networkCapture", scope: "userApps", loadPhase: "startup", dylib,
    env: { SIMNET_PROXY_PORT_FILE: "/foreign/port" },
  }], { relaunch: false, ownerPid: process.ppid });
  await expect(runtime.enableForDevice(UDID)).rejects.toThrow("another session");
  await runtime.disableForDevice(UDID);
  expect(env().DYLD_INSERT_LIBRARIES).toContain(dylib);
  expect(readFileSync(capabilityConfigPath(UDID), "utf8")).toContain("/foreign/port");
});


test("registry uncertain publication reports failure and remains available for cleanup", async () => {
  let closed = false;
  const runtime = captureHarness(async () => { closed = true; });
  writeFileSync(failurePath, "2");
  await expect(configureCapability(UDID, runtime.capability, { enabled: true, relaunch: false })).rejects.toThrow();
  expect(runtime.metaFor(UDID).attachment).toBe("failed");
  expect(closed).toBe(false);
  await configureCapability(UDID, runtime.capability, { enabled: false });
  expect(closed).toBe(true);
  await configureCapability(UDID, runtime.capability, { enabled: true, relaunch: false });
  expect(runtime.metaFor(UDID).attachment).toBe("capturing");
  await runtime.disableAll();
});


for (const uncertain of [false, true]) {
  test(`failure observers cannot skip ${uncertain ? "uncertainty reporting" : "resource rollback"}`, async () => {
    const calls: string[] = [];
    const observerError = new Error("failure observer threw");
    for (const name of ["first", "second"]) {
      registerCapability({
        name, scope: "userApps", loadPhase: "startup", defaultEnabled: true,
        async setEnabled() {
          return {
            dylib,
            failed() {
              calls.push(`failed:${name}`);
              if (name === "first") throw observerError;
            },
            async rollback() { calls.push(`rollback:${name}`); },
          };
        },
      });
    }
    writeFileSync(failurePath, uncertain ? "2" : "1");
    try {
      const error = await applyDefaultCapabilities(UDID, null).catch((error: unknown) => error);
      expect(calls).toEqual(uncertain
        ? ["failed:first", "failed:second"]
        : ["failed:first", "failed:second", "rollback:second", "rollback:first"]);
      expect(error).toBeInstanceOf(uncertain ? CapabilityRollbackError : AggregateError);
      if (!(error instanceof AggregateError)) throw new Error("Expected aggregate failure");
      expect(error.errors).toContain(observerError);
      expect(error.errors[0]).not.toBe(observerError);
    } finally {
      clearRegisteredCapabilities();
      removeCapabilityLoaderSync(UDID);
    }
  });
}
