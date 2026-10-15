import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

import {
  armCapabilityLoader,
  capabilityConfigPath,
  capabilityLoaderPath,
  clearLaunchState,
} from "../launch-manager";
import { stateDir } from "../state";
import { useTempStateDir, withShimsAsync } from "./helpers";
import { requireE2E } from "./e2e-preconditions";

// Needs the built capability loader, not a simulator: xcrun is a shim here. CI runs it
// with the other *.e2e.test.* suites, where a missing build fails instead of skipping.
const UDID = "CAPABILITY-ARMING-TEST-" + process.pid;

let tempState: { dir: string; restore(): void };

beforeAll(() => {
  tempState = useTempStateDir();
});

afterAll(() => {
  tempState.restore();
});

function writeRawState(contents: string): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(join(stateDir(), `launch-${UDID}.json`), contents);
}

afterEach(() => {
  clearLaunchState(UDID);
  try { unlinkSync(capabilityConfigPath(UDID)); } catch {}
});

const loaderBuilt = existsSync(capabilityLoaderPath());

requireE2E("capability loader arming", loaderBuilt);

describe.skipIf(!loaderBuilt)("armCapabilityLoader", () => {
  test("republishes the config before arming so a dead session's capability cannot load", async () => {
    const log = join(stateDir(), "simctl-arm-calls");
    const quotedLog = "'" + log.replaceAll("'", "'\\''") + "'";
    const quotedConfig = "'" + capabilityConfigPath(UDID).replaceAll("'", "'\\''") + "'";
    const dead = 999_999;
    writeRawState(JSON.stringify({
      launchArgs: [], sessionPids: [],
      capabilities: {
        camera: { name: "camera", scope: "allApps", dylib: "/camera.dylib", ownerPid: dead },
        probe: { name: "probe", scope: "allApps", dylib: "/probe.dylib", ownerPid: null },
        live: { name: "live", scope: "allApps", dylib: "/live.dylib", ownerPid: process.pid },
      },
    }));
    writeFileSync(
      capabilityConfigPath(UDID),
      "all\t/camera.dylib\t\t0\nall\t/probe.dylib\t\t0\nall\t/live.dylib\t\t0\n",
    );

    await withShimsAsync({ xcrun: `#!/bin/sh
printf '%s\\n' "$*" >> ${quotedLog}
if [ "$5" = "setenv" ] && [ "$6" = "DYLD_INSERT_LIBRARIES" ]; then
  printf 'config-at-arm:%s\\n' "$(cat ${quotedConfig} 2>/dev/null | tr '\\t\\n' '  ')" >> ${quotedLog}
fi
exit 0
` }, async () => {
      await armCapabilityLoader(UDID);
    });

    const atArm = readFileSync(log, "utf-8").split("\n").find((line) => line.startsWith("config-at-arm:"));
    expect(atArm).toContain("/probe.dylib");
    expect(atArm).toContain("/live.dylib");
    expect(atArm).not.toContain("/camera.dylib");
    expect(readFileSync(capabilityConfigPath(UDID), "utf-8")).toBe(
      "all\t/probe.dylib\t\t0\nall\t/live.dylib\t\t0\n",
    );
  });
});
