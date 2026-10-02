import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

import { e2eDevice, requireE2E } from "../../__tests__/e2e-preconditions";
import { parseDisabled } from "../launchd";

const PKG_DIR = join(import.meta.dir, "../../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");
// HomeKit: two services that no other suite uses. Undo enables them again, but they stay
// unloaded until the simulator reboots.
const PROFILE = "home";
const LABELS = ["com.apple.homed", "com.apple.homeeventsd"];

const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI);

requireE2E("serve-sim slim-simulator", ready);

let disabledBefore: string[] = [];

function disabledNow(): Set<string> {
  return parseDisabled(execFileSync("xcrun", ["simctl", "spawn", udid!, "launchctl", "print-disabled", "system"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  }));
}

function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("node", [CLI, "slim-simulator", "-d", udid!, ...args], { encoding: "utf-8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function statusLine(): string {
  const r = cli("--status");
  expect(r.status).toBe(0);
  return r.stdout.split("\n").find((line) => line.startsWith(`${PROFILE} `)) ?? "";
}

beforeAll(() => {
  if (!ready) return;
  const disabled = disabledNow();
  disabledBefore = LABELS.filter((label) => disabled.has(label));
}, 120_000);

afterAll(() => {
  if (!ready) return;
  // Leave each label as the suite found it, also when an assertion failed before the undo.
  for (const label of LABELS) {
    const verb = disabledBefore.includes(label) ? "disable" : "enable";
    try { execFileSync("xcrun", ["simctl", "spawn", udid!, "launchctl", verb, `system/${label}`], { stdio: "ignore" }); } catch {}
  }
}, 120_000);

describe.skipIf(!ready)("serve-sim slim-simulator", () => {
  test("applies a profile, shows it in --status, and undoes it", () => {
    const applied = cli("--profile", PROFILE);
    expect(applied.stderr).toBe("");
    expect(applied.status).toBe(0);
    expect(applied.stdout.trim()).toMatch(new RegExp(`^\\[slim\\] ${udid}: ${PROFILE}: \\d+ disabled, \\d+ unloaded$`));
    const disabled = disabledNow();
    for (const label of LABELS) expect(disabled.has(label)).toBe(true);
    expect(statusLine()).toMatch(new RegExp(`^${PROFILE}\\s+off\\s+2/2\\s`));

    // Nothing left to disable on a second run.
    expect(cli("--profile", PROFILE).stdout).toMatch(new RegExp(`: ${PROFILE}: 0 disabled, `));

    const undone = cli("--profile", PROFILE, "--undo");
    expect(undone.status).toBe(0);
    expect(undone.stdout).toContain(`[slim] ${udid}: ${PROFILE}: 2 enabled.`);
    const enabled = disabledNow();
    for (const label of LABELS) expect(enabled.has(label)).toBe(false);
    expect(statusLine()).toMatch(new RegExp(`^${PROFILE}\\s+on\\s+0/2\\s`));
  }, 300_000);
});
