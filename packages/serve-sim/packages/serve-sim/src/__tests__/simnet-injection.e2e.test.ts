
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import { enableCapabilities, disableCapability, releaseSessionSync } from "../launch-manager";
import { useTempStateDir } from "./helpers";
import { e2eDevice, requireE2E, readInsert } from "./e2e-preconditions";

const BUNDLE_ID = "dev.expo.serve-sim.simnet-probe";
const PROBE_HOST = "simnet-probe.test";
const DYLIB = resolve(import.meta.dir, "../../dist/simnet/libSimNetProxy.dylib");
const PROBE_APP = resolve(import.meta.dir, "../../dist/capability-loader/SimNetProbe.app");

const udid = e2eDevice();
const canRun = !!udid && existsSync(DYLIB) && existsSync(PROBE_APP);
const describeOrSkip = canRun ? describe : describe.skip;
requireE2E("simnet injection", canRun);

interface Probe {
  port: number;
  /** The first line the app sent, or null if it never connected. */
  firstLine: (timeoutMs: number) => Promise<string | null>;
  close: () => void;
}

/** A socket standing in for the capture proxy, so the assertion is on bytes the app actually sent. */
async function proxyStandIn(): Promise<Probe> {
  let resolveFirst: (value: string | null) => void = () => {};
  const first = new Promise<string | null>((r) => {
    resolveFirst = r;
  });

  const server: Server = createServer((socket) => {
    socket.once("data", (chunk) => {
      resolveFirst(chunk.toString("latin1").split("\r\n")[0]!);
      socket.destroy();
    });
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");

  return {
    port: address.port,
    firstLine: (timeoutMs) =>
      Promise.race([
        first,
        new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
      ]),
    close: () => server.close(),
  };
}

async function launchProbeApp(
  port: number,
  { inject, portFile, phase = "delegate" }: { inject: boolean; portFile?: string; phase?: string },
): Promise<void> {
  if (inject) {
    const file = portFile ?? join(appDir, "proxy-port");
    if (!portFile) writeFileSync(file, String(port));
    await enableCapabilities(udid!, null, [{
      name: "networkCapture", scope: "userApps", loadPhase: "startup", dylib: DYLIB,
      env: { SIMNET_PROXY_PORT_FILE: file },
    }], { relaunch: false });
  }
  execFileSync("xcrun", ["simctl", "launch", udid!, BUNDLE_ID], {
    stdio: "pipe", timeout: 30_000,
    env: { ...process.env, SIMCTL_CHILD_SIMNET_PROBE_URL: `https://${PROBE_HOST}/ping`,
      SIMCTL_CHILD_SIMNET_PROBE_PHASE: phase },
  });
}

function terminateProbeApp(): void {
  spawnSync("xcrun", ["simctl", "terminate", udid!, BUNDLE_ID], { stdio: "ignore" });
}

let appDir = "";
let tempState: ReturnType<typeof useTempStateDir>;
// Another tool on this simulator may rely on its insert; the suite restores it when it finishes.
let insertBefore = "";

describeOrSkip("SimNetProxy injection (real simulator)", () => {
  beforeAll(() => {
    insertBefore = readInsert(udid!) ?? "";
    spawnSync("xcrun", ["simctl", "spawn", udid!, "launchctl", "unsetenv", "DYLD_INSERT_LIBRARIES"], { stdio: "ignore" });
    tempState = useTempStateDir();
    appDir = mkdtempSync(join(tmpdir(), "simnet-probe-"));
    execFileSync("xcrun", ["simctl", "install", udid!, PROBE_APP], {
      stdio: "pipe",
      timeout: 60_000,
    });
  }, 240_000);

  afterEach(async () => {
    terminateProbeApp();
    await disableCapability(udid!, null, "networkCapture", { relaunch: false });
  }, 60_000);

  afterAll(() => {
    // The fixture app is the only thing this test adds to the device, and it does not outlive the test.
    terminateProbeApp();
    spawnSync("xcrun", ["simctl", "uninstall", udid!, BUNDLE_ID], { stdio: "ignore" });
    releaseSessionSync(udid!, process.pid, () => {});
    if (appDir) rmSync(appDir, { recursive: true, force: true });
    try {
      expect(readInsert(udid!)).toBe("");
      expect(execFileSync("xcrun", ["simctl", "spawn", udid!, "launchctl", "getenv", "SIMNET_PROXY_PORT_FILE"], { encoding: "utf8" }).trim()).toBe("");
    } finally {
      if (insertBefore) {
        spawnSync("xcrun", ["simctl", "spawn", udid!, "launchctl", "setenv", "DYLD_INSERT_LIBRARIES", insertBefore], { stdio: "ignore" });
      }
      tempState.restore();
    }
  }, 60_000);

  it(
    "sends the app's HTTPS request to the proxy as a CONNECT",
    async () => {
      const probe = await proxyStandIn();
      try {
        terminateProbeApp();
        await launchProbeApp(probe.port, { inject: true });

        const line = await probe.firstLine(25_000);
        expect(line).not.toBeNull();
        expect(line).toStartWith(`CONNECT ${PROBE_HOST}:443`);
      } finally {
        probe.close();
      }
    },
    60_000,
  );

  it("keeps a non-UIKit process running with startup images armed", async () => {
    const probe = await proxyStandIn();
    try {
      await launchProbeApp(probe.port, { inject: true });
      expect(spawnSync("xcrun", ["simctl", "spawn", udid!, "/usr/bin/true"], { env: { ...process.env } }).status).toBe(0);
    } finally { probe.close(); }
  }, 60_000);

  for (const phase of ["load", "constructor", "configuration"]) {
    it(`captures a session retained from ${phase}`, async () => {
      const probe = await proxyStandIn();
      try {
        terminateProbeApp();
        await launchProbeApp(probe.port, { inject: true, phase });
        expect(await probe.firstLine(25_000)).toStartWith(`CONNECT ${PROBE_HOST}:443`);
      } finally { probe.close(); }
    }, 60_000);
  }

  it(
    "reads the port from a file, which is how a device booted for capture is pointed at the proxy",
    async () => {
      const probe = await proxyStandIn();
      const portFile = join(appDir, "proxy-port");
      writeFileSync(portFile, String(probe.port));
      try {
        terminateProbeApp();
        await launchProbeApp(probe.port, { inject: true, portFile });

        const line = await probe.firstLine(25_000);
        expect(line).toStartWith(`CONNECT ${PROBE_HOST}:443`);
      } finally {
        probe.close();
        rmSync(portFile, { force: true });
      }
    },
    60_000,
  );

  it(
    "leaves the app unproxied once the port file is gone",
    async () => {
      const probe = await proxyStandIn();
      const missing = join(appDir, "proxy-port-that-was-removed");
      rmSync(missing, { force: true });
      try {
        terminateProbeApp();
        await launchProbeApp(probe.port, { inject: true, portFile: missing });

        expect(await probe.firstLine(8_000)).toBeNull();
      } finally {
        probe.close();
      }
    },
    60_000,
  );

  it(
    "leaves the app alone when the dylib is not injected",
    async () => {
      const probe = await proxyStandIn();
      try {
        terminateProbeApp();
        await launchProbeApp(probe.port, { inject: false });

        expect(await probe.firstLine(8_000)).toBeNull();
      } finally {
        probe.close();
      }
    },
    60_000,
  );
});
