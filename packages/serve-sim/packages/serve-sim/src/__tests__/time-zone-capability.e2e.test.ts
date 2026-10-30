import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";

import { e2eDevice, requireE2E } from "./e2e-preconditions";
import {
  armCapabilityLoader,
  capabilityConfigPath,
  capabilityLoaderPath,
  clearLaunchState,
  removeCapabilityLoader,
} from "../launch-manager";
import { timeZoneDylib, timeZoneFile } from "../time-zone-capability";
import { HOST_TIME_ZONE } from "../time-zone";
import { writeTimeZone } from "../ui-settings";

// Proves the part no unit test can: a zone change reaches an app that is already
// running, in the same process, with SpringBoard left alone. The fixture records
// what it sees itself, from Foundation and from libc.

const DIST = join(import.meta.dir, "../../dist/capability-loader");
const FIXTURE = join(DIST, "ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.launch-fixture";
const SPRINGBOARD = "com.apple.SpringBoard";

const udid = e2eDevice();
const ready =
  udid !== null &&
  existsSync(FIXTURE) &&
  existsSync(capabilityLoaderPath()) &&
  existsSync(timeZoneDylib());
requireE2E("time-zone capability (needs the built loader, dylib and launch fixture)", ready);

function simctl(args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

function terminate(): void {
  try {
    simctl(["terminate", udid!, APP]);
  } catch {}
}

function launch(): number {
  const output = simctl(["launch", "--terminate-running-process", udid!, APP, "--time-zone-test"]);
  const pid = Number(output.trim().match(/:\s*(\d+)$/)?.[1]);
  if (!Number.isSafeInteger(pid)) throw new Error(`No fixture PID in simctl response: ${output}`);
  return pid;
}

function jobPid(label: string): number | null {
  for (const line of simctl(["spawn", udid!, "launchctl", "list"]).split("\n")) {
    const [pid, , job = ""] = line.split("\t");
    if (job === label) return Number(pid) || null;
  }
  return null;
}

interface ZoneRecord {
  pid: number;
  name: string;
  offset: number;
  notes: number;
}

function zoneRecords(): ZoneRecord[] {
  try {
    const container = simctl(["get_app_container", udid!, APP, "data"]).trim();
    return readFileSync(join(container, "Documents/launches.tsv"), "utf-8")
      .split("\n")
      .filter((line) => line.startsWith("tz\t"))
      .map((line) => {
        const [, pid, detail = ""] = line.split("\t");
        const [name = "", offset = "", notes = ""] = detail.split("|");
        return { pid: Number(pid), name, offset: Number(offset), notes: Number(notes) };
      });
  } catch {
    return [];
  }
}

async function waitForZone(
  pid: number,
  match: (record: ZoneRecord) => boolean,
): Promise<ZoneRecord> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const found = zoneRecords()
      .filter((record) => record.pid === pid)
      .at(-1);
    if (found && match(found)) return found;
    if (Date.now() >= deadline) {
      throw new Error(
        `fixture ${pid} never matched; last record: ${JSON.stringify(found ?? null)}`,
      );
    }
    await Bun.sleep(250);
  }
}

function resetState(): void {
  clearLaunchState(udid!);
  try {
    rmSync(capabilityConfigPath(udid!));
  } catch {}
  try {
    rmSync(timeZoneFile(udid!));
  } catch {}
}

describe.skipIf(!ready)("time-zone capability on a real simulator", () => {
  beforeAll(async () => {
    terminate();
    await writeTimeZone(udid!, HOST_TIME_ZONE);
    resetState();
    try {
      simctl(["uninstall", udid!, APP]);
    } catch {}
    simctl(["install", udid!, FIXTURE]);
    // What a session does first: arm the loader, so this process owns the capability and
    // the fixture launches carrying it.
    await armCapabilityLoader(udid!);
  }, 90_000);

  afterAll(async () => {
    terminate();
    try {
      await writeTimeZone(udid!, HOST_TIME_ZONE);
    } catch {}
    await removeCapabilityLoader(udid!);
    resetState();
    try {
      simctl(["uninstall", udid!, APP]);
    } catch {}
  }, 90_000);

  test("switches a running app between zones and back to host, in the same process", async () => {
    const springboard = jobPid(SPRINGBOARD);
    const pid = launch();
    const host = await waitForZone(pid, () => true);

    await writeTimeZone(udid!, "Asia/Tokyo");
    const tokyo = await waitForZone(pid, (r) => r.name === "Asia/Tokyo");
    // Tokyo has no daylight saving, so libc's offset is fixed.
    expect(tokyo.offset).toBe(9 * 3600);
    expect(tokyo.notes).toBeGreaterThan(host.notes);

    await writeTimeZone(udid!, "UTC");
    const utc = await waitForZone(pid, (r) => r.offset === 0 && r.name !== "Asia/Tokyo");
    expect(utc.notes).toBeGreaterThan(tokyo.notes);

    await writeTimeZone(udid!, HOST_TIME_ZONE);
    const back = await waitForZone(pid, (r) => r.notes > utc.notes);
    expect(back.name).toBe(host.name);
    expect(back.offset).toBe(host.offset);

    expect(zoneRecords().some((r) => r.pid !== pid)).toBe(false);
    expect(jobPid(SPRINGBOARD)).toBe(springboard);
  }, 120_000);

  test("an app launched after the change starts in the new zone", async () => {
    await writeTimeZone(udid!, "Asia/Tokyo");
    const pid = launch();
    const first = await waitForZone(pid, () => true);
    expect(first.name).toBe("Asia/Tokyo");
    expect(first.offset).toBe(9 * 3600);
    await writeTimeZone(udid!, HOST_TIME_ZONE);
  }, 120_000);

  test("after a reboot clears TZ, an app launched later keeps the host zone", async () => {
    const host = await waitForZone(launch(), () => true);
    await writeTimeZone(udid!, "Asia/Tokyo");
    // What a reboot does to launchd; the zone file and the session's record stay.
    simctl(["spawn", udid!, "launchctl", "unsetenv", "TZ"]);
    const pid = launch();
    await waitForZone(pid, () => true);
    // The dylib loads after launch, and the fixture records every change it sees.
    await Bun.sleep(3_000);
    const last = zoneRecords()
      .filter((record) => record.pid === pid)
      .at(-1);
    expect(last?.name).toBe(host.name);
    expect(last?.offset).toBe(host.offset);
    await writeTimeZone(udid!, HOST_TIME_ZONE);
  }, 120_000);
});
