import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { dirname, join } from "path";

import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { HOST_CLOCK } from "../clock";
import { clockDylib, clockFile } from "../clock-capability";
import {
  armCapabilityLoader,
  capabilityConfigPath,
  capabilityLoaderPath,
  clearLaunchState,
  releaseSessionSync,
  removeCapabilityLoader,
} from "../launch-manager";
import { HOST_TIME_ZONE } from "../time-zone";
import { writeClock, writeTimeZone } from "../ui-settings";

// Proves the part no unit test can: an app that is already running sees another date and time,
// in the same process, from Foundation, libc and JavaScriptCore alike, and gets it back.

const DIST = join(import.meta.dir, "../../dist/capability-loader");
const FIXTURE = join(DIST, "ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.launch-fixture";
const SPRINGBOARD = "com.apple.SpringBoard";
// 2030-01-01T00:00:00Z, in seconds.
const TARGET = Date.UTC(2030, 0, 1) / 1000;

const udid = e2eDevice();
const ready =
  udid !== null &&
  existsSync(FIXTURE) &&
  existsSync(capabilityLoaderPath()) &&
  existsSync(clockDylib());
requireE2E("clock capability (needs the built loader, dylib and launch fixture)", ready);

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
  const output = simctl(["launch", "--terminate-running-process", udid!, APP, "--clock-test"]);
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

interface ClockRecord {
  pid: number;
  /** Seconds since 1970, from Foundation, libc and JavaScriptCore. */
  foundation: number;
  libc: number;
  script: number;
  clockNotes: number;
  significant: number;
}

function clockRecords(): ClockRecord[] {
  try {
    const container = simctl(["get_app_container", udid!, APP, "data"]).trim();
    return readFileSync(join(container, "Documents/launches.tsv"), "utf-8")
      .split("\n")
      .filter((line) => line.startsWith("clock\t"))
      .map((line) => {
        const [, pid, detail = ""] = line.split("\t");
        const [foundation, libc, script, clockNotes, significant] = detail.split("|").map(Number);
        return {
          pid: Number(pid),
          foundation: foundation!,
          libc: libc!,
          script: script!,
          clockNotes: clockNotes!,
          significant: significant!,
        };
      });
  } catch {
    return [];
  }
}

async function waitForClock(
  pid: number,
  match: (record: ClockRecord) => boolean,
): Promise<ClockRecord> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const found = clockRecords()
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

const WAITS = ["wait-condition", "wait-walltime", "wait-walltime-now", "wait-walltime-timespec"];

/** How long each wall-clock deadline of 300 ms took in the fixture, by kind. */
function waitRecords(pid: number): Record<string, number[]> {
  const container = simctl(["get_app_container", udid!, APP, "data"]).trim();
  const rows = readFileSync(join(container, "Documents/launches.tsv"), "utf-8")
    .split("\n")
    .map((line) => line.split("\t"));
  return Object.fromEntries(
    WAITS.map((kind) => [
      kind,
      rows.filter(([k, p]) => k === kind && Number(p) === pid).map(([, , ms]) => Number(ms)),
    ]),
  );
}

/**
 * The fixture probes its deadlines at launch and after each clock change. A deadline is turned
 * real when it is made, so every probe takes its real 300 ms, even one made during a change.
 */
async function expectRealDeadlines(pid: number, probes: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const waits = waitRecords(pid);
    if (WAITS.every((kind) => waits[kind]!.length >= probes)) {
      const unreal = WAITS.flatMap((kind) =>
        waits[kind]!.filter((ms) => ms < 250 || ms >= 1500).map((ms) => `${kind} ${ms} ms`),
      );
      expect(unreal).toEqual([]);
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`a wall deadline never expired in ${pid}: ${JSON.stringify(waits)}`);
    }
    await Bun.sleep(250);
  }
}

/** The probe count once no probe has finished for 2 s, all of them real so far. */
async function settledProbes(pid: number): Promise<number> {
  const count = () => Math.min(...WAITS.map((kind) => waitRecords(pid)[kind]!.length));
  let last = -1;
  while (count() !== last) {
    last = count();
    await Bun.sleep(2_000);
  }
  await expectRealDeadlines(pid, last);
  return last;
}

/** Within a minute after `at`, from all three clocks. */
const near = (at: number) => (record: ClockRecord) =>
  [record.foundation, record.libc, record.script].every(
    (seconds) => seconds >= at - 5 && seconds <= at + 60,
  );
const now = () => Date.now() / 1000;

function resetState(): void {
  clearLaunchState(udid!);
  try {
    rmSync(capabilityConfigPath(udid!));
  } catch {}
  // The whole directory: the first set on a device must create it before any dylib watches it.
  rmSync(dirname(clockFile(udid!)), { recursive: true, force: true });
}

describe.skipIf(!ready)("clock capability on a real simulator", () => {
  beforeAll(async () => {
    terminate();
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
      await writeClock(udid!, HOST_CLOCK);
      await writeTimeZone(udid!, HOST_TIME_ZONE);
    } catch {}
    await removeCapabilityLoader(udid!);
    resetState();
    try {
      simctl(["uninstall", udid!, APP]);
    } catch {}
  }, 90_000);

  test("moves a running app's clock and back to the Mac's, in the same process", async () => {
    const springboard = jobPid(SPRINGBOARD);
    const pid = launch();
    const host = await waitForClock(pid, near(now()));
    // The launch probe first, so the next probe is the one after the change.
    await expectRealDeadlines(pid, 1);

    await writeClock(udid!, "2030-01-01T00:00:00Z");
    const shifted = await waitForClock(pid, near(TARGET));
    expect(shifted.clockNotes).toBeGreaterThan(host.clockNotes);
    // A later time must not hang a timed wait.
    await expectRealDeadlines(pid, 2);
    // What Calendar and other apps that keep their own time refresh on.
    const signalled = await waitForClock(pid, (r) => r.significant > host.significant);
    expect(near(TARGET)(signalled)).toBe(true);

    await writeClock(udid!, HOST_CLOCK);
    const back = await waitForClock(pid, (r) => r.clockNotes > signalled.clockNotes);
    expect(near(now())(back)).toBe(true);

    expect(clockRecords().some((r) => r.pid !== pid)).toBe(false);
    expect(jobPid(SPRINGBOARD)).toBe(springboard);
  }, 120_000);

  test("from one set time straight to an earlier one, timed waits keep their length", async () => {
    const pid = launch();
    await waitForClock(pid, near(now()));
    await writeClock(udid!, "2030-01-01T00:00:00Z");
    await waitForClock(pid, near(TARGET));
    // Each change probes more than once (its own notifications), so count after they settle.
    const before = await settledProbes(pid);
    // An earlier time must not end a timed wait at once.
    await writeClock(udid!, "2020-01-01T00:00:00Z");
    await waitForClock(pid, near(Date.UTC(2020, 0, 1) / 1000));
    await expectRealDeadlines(pid, before + 1);
    await writeClock(udid!, HOST_CLOCK);
  }, 120_000);

  test("an app launched after the change starts at the new time", async () => {
    await writeClock(udid!, "2030-01-01T00:00:00Z");
    const pid = launch();
    await waitForClock(pid, near(TARGET));
    // From +load, before the main queue runs: only the image inserted at exec moves it.
    const container = simctl(["get_app_container", udid!, APP, "data"]).trim();
    const atLoad = readFileSync(join(container, "Documents/launches.tsv"), "utf-8")
      .split("\n")
      .map((line) => line.split("\t"))
      .find(([kind, p]) => kind === "clock-load" && Number(p) === pid);
    const seconds = Number(atLoad?.[2]);
    expect(seconds >= TARGET - 5 && seconds <= TARGET + 60).toBe(true);
    await writeClock(udid!, HOST_CLOCK);
  }, 120_000);

  test("when the session ends, a running app returns to the host time", async () => {
    await writeClock(udid!, "2030-01-01T00:00:00Z");
    const pid = launch();
    const shifted = await waitForClock(pid, near(TARGET));
    // What a session does when it exits: it releases its records and, as the last owner,
    // takes the loader and its config away.
    releaseSessionSync(udid!, process.pid, () => {});
    const back = await waitForClock(pid, (r) => r.clockNotes > shifted.clockNotes);
    expect(near(now())(back)).toBe(true);
    // The next test needs a session again.
    await armCapabilityLoader(udid!);
  }, 120_000);

  test("reads a time without a zone in the simulator's zone", async () => {
    await writeTimeZone(udid!, "Asia/Tokyo");
    // 09:00 in Tokyo is midnight UTC.
    await writeClock(udid!, "2030-01-01T09:00");
    await waitForClock(launch(), near(TARGET));
    await writeClock(udid!, HOST_CLOCK);
    await writeTimeZone(udid!, HOST_TIME_ZONE);
  }, 120_000);
});
