import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { createLogBufferCache, type LogLine } from "../log-buffer";
import { e2eDevice, requireE2E } from "./e2e-preconditions";

const APP = "dev.expo.serve-sim.launch-fixture";
const FIXTURE = join(import.meta.dir, "../../dist/capability-loader/ServeSimLaunchFixture.app");
const MARKER = "SERVE_SIM_USER_APP_LOG_MARKER";
const udid = e2eDevice();
const ready = udid !== null && existsSync(FIXTURE);
requireE2E("user-app logs (needs the built launch fixture)", ready);

type RecordFields = { processImagePath?: string; processID?: number; eventMessage?: string };
function fields(line: LogLine): RecordFields | null {
  try {
    const value: unknown = JSON.parse(line.raw);
    return value !== null && typeof value === "object" ? value as RecordFields : null;
  } catch {
    return null;
  }
}

describe.skipIf(!ready)("user-app logs with a real simulator", () => {
  const cache = createLogBufferCache();
  const markers = { all: new Set<number>(), apps: new Set<number>() };
  const releases: (() => void)[] = [];
  let sawDefaultSystemRecord = false;
  let badFilteredRecords = 0;
  let installed = false;

  beforeAll(() => {
    // Use only the runner's pinned device; never remove another session's server.
    execFileSync("xcrun", ["simctl", "install", udid!, FIXTURE], { timeout: 30_000 });
    installed = true;
  });

  afterAll(() => {
    for (const release of releases) release();
    cache.stopAll();
    if (installed) {
      spawnSync("xcrun", ["simctl", "terminate", udid!, APP], { stdio: "ignore", timeout: 10_000 });
      spawnSync("xcrun", ["simctl", "uninstall", udid!, APP], { stdio: "ignore", timeout: 30_000 });
    }
  });

  function launch(): number {
    const output = execFileSync("xcrun", [
      "simctl", "launch", "--terminate-running-process", udid!, APP, "--logs-test",
    ], { encoding: "utf8", timeout: 30_000 });
    const pid = Number(output.trim().match(/:\s*(\d+)$/)?.[1]);
    if (!Number.isSafeInteger(pid)) throw new Error(`No fixture PID in simctl response: ${output}`);
    return pid;
  }

  async function waitForBoth(pid: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (markers.all.has(pid) && markers.apps.has(pid) && sawDefaultSystemRecord) return;
      await Bun.sleep(100);
    }
    expect(markers.all.has(pid), `default stream missed fixture PID ${pid}`).toBe(true);
    expect(markers.apps.has(pid), `user-app stream missed fixture PID ${pid}`).toBe(true);
    expect(sawDefaultSystemRecord, "default stream must retain system logs").toBe(true);
  }

  test("keeps default system logs while filtering app logs across relaunch", async () => {
    const all = cache.ensure(udid!);
    const apps = cache.ensure(udid!, "user-apps");
    for (const [scope, buffer] of [["all", all], ["apps", apps]] as const) {
      releases.push(buffer.subscribeBatch(lines => {
        for (const line of lines) {
          const record = fields(line);
          // Recognize the fixture independently of the production classifier.
          const fixture = record?.processImagePath?.endsWith("/ServeSimLaunchFixture.app/ServeSimLaunchFixture");
          const inAppContainer = record?.processImagePath?.toLowerCase().includes("/containers/bundle/application/");
          if (scope === "apps" && !inAppContainer) badFilteredRecords++;
          if (scope === "all" && record?.processImagePath && !inAppContainer) {
            sawDefaultSystemRecord = true;
          }
          if (fixture && record?.eventMessage?.includes(MARKER) && typeof record.processID === "number") {
            markers[scope].add(record.processID);
          }
        }
      }));
    }
    const first = launch();
    await waitForBoth(first);
    const second = launch();
    expect(second).not.toBe(first);
    await waitForBoth(second);
    expect(badFilteredRecords).toBe(0);
    expect(cache.peek(udid!)).toBe(all);
    expect(cache.peek(udid!, "user-apps")).toBe(apps);
    expect(apps).not.toBe(all);
    for (const pid of [first, second]) {
      expect(apps.read().some(line => {
        const record = fields(line);
        return record?.processID === pid && record.eventMessage?.includes(MARKER);
      })).toBe(true);
    }
  }, 90_000);
});
