import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { e2eDevice, readInsert, requireE2E } from "./e2e-preconditions";
import { freePortAsync, installShims, killHelpersForDevice, useTempStateDir } from "./helpers";

const CLI = join(import.meta.dir, "../..", "dist/serve-sim.js");

const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI);
requireE2E("simctl calls before the preview is ready", ready);

const describeOrSkip = ready ? describe : describe.skip;

async function waitForAsync(check: () => boolean, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await Bun.sleep(100);
  expect(check()).toBe(true);
}

// Each simctl call costs a fraction of a second, and serve-sim makes them one after another before
// its preview answers, so a repeated call is start time.
describeOrSkip("simctl calls before the preview is ready", () => {
  let tempState: ReturnType<typeof useTempStateDir>;
  let shims: ReturnType<typeof installShims>;
  let server: ChildProcess | undefined;
  let calls: string[] = [];
  let insertBefore: string | null = null;
  const log = () => join(tempState.dir, "xcrun.log");
  const stateFile = () => join(tempState.dir, `server-${udid!}.json`);

  beforeAll(async () => {
    tempState = useTempStateDir();
    killHelpersForDevice(udid!);
    insertBefore = readInsert(udid!);
    // Logs each call, then runs the real xcrun.
    shims = installShims({ xcrun: `#!/bin/sh\necho "$*" >> ${JSON.stringify(log())}\nexec /usr/bin/xcrun "$@"\n` });
    const port = await freePortAsync();
    server = spawn("node", [CLI, "--require-token", "--quiet", "--port", String(port), udid!], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env },
    });
    await waitForAsync(() => existsSync(stateFile()));
    calls = readFileSync(log(), "utf-8").trim().split("\n");
  }, 120_000);

  afterAll(async () => {
    if (server?.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          server?.kill("SIGKILL");
          done();
        }, 30_000);
        server!.on("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
    }
    shims?.restore();
    tempState?.restore();
  }, 60_000);

  test("waits for the boot once", () => {
    expect(calls.filter((call) => call.startsWith(`simctl bootstatus ${udid}`))).toHaveLength(1);
  });

  test("starts on a device with no serve-sim insert left behind", () => {
    // A loader or startup image an earlier run left inserted makes the stale check read the
    // insert again, under the lock, so the counts below would not hold.
    expect(insertBefore).not.toBeNull();
    expect(insertBefore).not.toMatch(/libServeSim(CapabilityLoader|Trampoline)\.dylib|libSimNetProxy\.dylib/);
  });

  test("reads each launchd value only as often as arming needs", () => {
    // One read clears a stale loader; the snapshot that arming can roll back to reads both values.
    const reads = (name: string) => calls.filter((call) => call === `simctl spawn ${udid} launchctl getenv ${name}`);
    expect(reads("DYLD_INSERT_LIBRARIES")).toHaveLength(2);
    expect(reads("SERVE_SIM_CAPABILITIES_CONFIG")).toHaveLength(1);
  });
});
