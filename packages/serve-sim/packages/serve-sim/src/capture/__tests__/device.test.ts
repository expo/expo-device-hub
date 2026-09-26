import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeviceInjected, proxyDylibCandidates } from "../device";
import { useTempStateDir } from "../../__tests__/helpers";
import { writeLaunchState } from "../../launch-state";
import { capabilityConfigPath, commitCapabilityConfig, renderCapabilityConfig } from "../../capability-config";
import { capabilityLoaderPath } from "../../launch-manager";

const UDID = "ABCD1234-0000-0000-0000-0000000000EF";
const DYLIB = "/opt/libSimNetProxy.dylib";
let tempState: ReturnType<typeof useTempStateDir>;
let portFile: string;
beforeEach(() => {
  tempState = useTempStateDir();
  portFile = join(tempState.dir, "proxy-port");
  writeFileSync(portFile, "9123");
  const state = {
    launchArgs: [],
    capabilities: {
      networkCapture: {
        name: "networkCapture", dylib: DYLIB, scope: "userApps" as const,
        loadPhase: "startupAndDeferred" as const, ownerPid: null, bundleId: null,
        env: { SIMNET_PROXY_PORT_FILE: portFile },
      },
    },
  };
  writeLaunchState(UDID, state);
  commitCapabilityConfig(UDID, renderCapabilityConfig(state));
});
afterEach(() => tempState.restore());

const readEnv = (inserts: string) => async (args: string[]) =>
  args.at(-1) === "SERVE_SIM_CAPABILITIES_CONFIG" ? capabilityConfigPath(UDID) : inserts;

test("capture is healthy when its session, port file, and startup images are armed", async () => {
  expect(await isDeviceInjected(UDID, portFile, {
    read: readEnv(`${capabilityLoaderPath()}:${DYLIB}`), expectedPort: 9123,
  })).toBe(true);
});

test("capture is unhealthy when the startup image is removed", async () => {
  expect(await isDeviceInjected(UDID, portFile, {
    read: readEnv(capabilityLoaderPath()),
  })).toBe(false);
});

test("capture is unhealthy when the port file belongs to another session", async () => {
  expect(await isDeviceInjected(UDID, "/tmp/other-confdir/proxy-port", {
    read: readEnv(`${capabilityLoaderPath()}:${DYLIB}`),
  })).toBe(false);
});

test("capture is unhealthy when the port file is missing or names an old proxy", async () => {
  rmSync(portFile);
  expect(await isDeviceInjected(UDID, portFile, { read: readEnv(`${capabilityLoaderPath()}:${DYLIB}`), expectedPort: 9123 })).toBe(false);
  writeFileSync(portFile, "9124");
  expect(await isDeviceInjected(UDID, portFile, { read: readEnv(`${capabilityLoaderPath()}:${DYLIB}`), expectedPort: 9123 })).toBe(false);
});

test("proxyDylibCandidates includes the checkout's native build", () => {
  expect(proxyDylibCandidates()).toContain(resolve(import.meta.dir, "../../../dist/simnet/libSimNetProxy.dylib"));
});
