import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runHostActionAsync } from "../host-actions";
import { EXIT_0_SHIM, UDID, installShims } from "./helpers";

const STAGING = join(tmpdir(), "serve-sim-screenshots");
const SCREENSHOT_PREFIX = "serve-sim-screenshot-";
const FILLER_PREFIX = `${SCREENSHOT_PREFIX}ceil-`;
const OTHER_PREFIX = "holiday-";
const MAX_SCREENSHOT_AGE_MS = 6 * 60 * 60 * 1000;
// This is the live staging directory, and a run killed part-way (the CI watchdog does that) leaves
// its fixtures behind with nothing to remove them. Backdated to two minutes inside the retention
// window, they are gone at the product's own next prune instead of refusing every real screenshot
// for six hours. Two minutes is far longer than this file runs, so the prune at the start of a
// capture cannot remove a filler a test is still counting on.
const FIXTURE_MTIME_MS = Date.now() - MAX_SCREENSHOT_AGE_MS + 2 * 60 * 1000;
const params = { udid: UDID, fileName: "serve-sim-screenshot-next.png" };

let shims: ReturnType<typeof installShims>;

beforeAll(() => {
  shims = installShims({ xcrun: EXIT_0_SHIM, cp: EXIT_0_SHIM });
  mkdirSync(STAGING, { recursive: true });
});

afterAll(() => {
  shims.restore();
  clearFixtures();
});

function isFixture(entry: string): boolean {
  return (
    entry.startsWith(FILLER_PREFIX) || entry.startsWith(OTHER_PREFIX) || entry === params.fileName
  );
}

/** Only this file's fixtures, so a capture staged by another file keeps its own ceiling arithmetic. */
function clearFixtures(): void {
  for (const entry of readdirSync(STAGING)) {
    if (isFixture(entry)) rmSync(join(STAGING, entry), { force: true });
  }
}

function writeFixture(name: string): void {
  const p = join(STAGING, name);
  writeFileSync(p, "");
  utimesSync(p, FIXTURE_MTIME_MS / 1000, FIXTURE_MTIME_MS / 1000);
}

/** Brings the staged count to `screenshots`; an operator's own recent captures count toward it. */
function stage(screenshots: number, others = 0): void {
  clearFixtures();
  const existing = readdirSync(STAGING).filter((e) => e.startsWith(SCREENSHOT_PREFIX)).length;
  for (let i = 0; i < screenshots - existing; i += 1) writeFixture(`${FILLER_PREFIX}${i}.png`);
  for (let i = 0; i < others; i += 1) writeFixture(`${OTHER_PREFIX}${i}.png`);
}

const capture = (): ReturnType<typeof runHostActionAsync> =>
  runHostActionAsync({ action: "screenshot.capture", params }, "true");

describe("screenshot ceiling", () => {
  it("refuses once the staging area already holds the ceiling", async () => {
    stage(200);
    const result = await capture();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("screenshots are already staged");
  });

  it("keeps capturing one under the ceiling", async () => {
    stage(199);
    expect((await capture()).exitCode).toBe(0);
  });

  it("does not count unrelated staged files toward the ceiling", async () => {
    stage(0, 300);
    expect((await capture()).exitCode).toBe(0);
  });
});
