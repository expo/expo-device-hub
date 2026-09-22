import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { stateDir } from "../state";
import { parseDetachState } from "./detach-state";
import { freePortAsync } from "./helpers";
import { sendKeyEventsToWs } from "../text-to-keys";
import { restoreHingeState, selectHingeControl, selectPose } from "./duo-hinge-helpers";
import type { ServeSimDeviceState } from "../state";
import type { StreamConfig } from "../client/types";

/**
 * Native e2e for `serve-sim type`.
 *
 * Boots through the full stack: textToKeyEvents → WS 0x06 frames →
 * DeviceSession → HIDInjector.sendKey → a focused UIKit text field in the
 * existing launch fixture. Input logs alone cannot prove guest delivery:
 * legacy Indigo keyboard events were logged but dropped on iPhone Duo.
 *
 * Those per-event HID logs are gated behind `SERVE_SIM_DEBUG_HID` (they otherwise
 * flood stdout), so the server is started with that env set to make them visible.
 *
 * Skipped automatically when no iOS simulator is booted, so this stays green
 * on machines without one. The macOS CI job boots a sim explicitly and runs
 * `bun test packages/serve-sim/src/__tests__/`, so it runs there.
 */

const CLI_PATH = join(import.meta.dir, "../../dist/serve-sim.js");
const FIXTURE = join(import.meta.dir, "../../dist/capability-loader/ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.launch-fixture";

// Match the existing Duo E2E opt-in. The guest-delivery regression changes the
// physical pose and needs a Duo; the original dispatch test runs on any sim.
// Set SERVE_SIM_TEST_UDID and SERVE_SIM_DUO_E2E_DEVICE to the same Duo UDID.
const duoDevice = process.env.SERVE_SIM_DUO_E2E_DEVICE;
const bootedUdid = e2eDevice();
const testDuo = duoDevice !== undefined && duoDevice === bootedUdid && existsSync(FIXTURE);
const ready = bootedUdid !== null && existsSync(CLI_PATH);
requireE2E("serve-sim typing", ready);
const describeWithSim = ready ? describe : describe.skip;

function cli(...args: string[]): string {
  return execFileSync("node", [CLI_PATH, ...args], { encoding: "utf8", timeout: 15_000 });
}

function simctl(...args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8", stdio: "pipe", timeout: 30_000 });
}

describeWithSim(`serve-sim type e2e (booted sim ${bootedUdid ?? "<skipped>"})`, () => {
  let logFile: string;
  let fixtureLog: string;
  let state: ServeSimDeviceState;

  function fixtureLines(): string[] {
    try { return readFileSync(fixtureLog, "utf8").split("\n").filter(Boolean); }
    catch { return []; }
  }

  async function screenConfig(): Promise<StreamConfig> {
    const response = await fetch(state.streamUrl.replace(/\/stream\.[^/]+$/, "/config"), {
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
    expect(response.ok).toBe(true);
    return response.json();
  }

  async function waitFor<T>(read: () => T | Promise<T>, expected: Awaited<T>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await read() === expected) return;
      await Bun.sleep(100);
    }
    expect(await read()).toBe(expected);
  }

  beforeAll(async () => {
    try { cli("--kill", bootedUdid!); } catch {}
    if (testDuo) {
      try { simctl("uninstall", bootedUdid!, APP); } catch {}
      simctl("install", bootedUdid!, FIXTURE);
      const container = simctl("get_app_container", bootedUdid!, APP, "data").trim();
      fixtureLog = join(container, "Documents/launches.tsv");
    }

    const startPort = await freePortAsync();
    const detach = spawnSync("node", [CLI_PATH, "--detach", "-p", String(startPort), bootedUdid!], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 120_000,
      // Surface the per-event `[hid] Key …` lines this test asserts on; the
      // env propagates to the detached `serve` child the CLI re-execs.
      env: { ...process.env, SERVE_SIM_DEBUG_HID: "1" },
    });
    if (detach.status !== 0 || !detach.stdout) {
      throw new Error(
        `serve-sim --detach failed (exit=${detach.status} signal=${detach.signal})\nstdout: ${detach.stdout}`,
      );
    }
    state = parseDetachState<ServeSimDeviceState>(detach.stdout);
    logFile = join(stateDir(), `server-${state.device}.log`);
  }, 180_000);

  afterAll(() => {
    try { cli("--kill", bootedUdid!); } catch {}
    if (testDuo) {
      try { simctl("terminate", bootedUdid!, APP); } catch {}
      try { simctl("uninstall", bootedUdid!, APP); } catch {}
    }
  }, 60_000);

  test("`serve-sim type` injects HID key events into the booted simulator", async () => {
    const logBefore = readFileSync(logFile, "utf-8");
    const beforeCount = countKeyLines(logBefore);

    // "Hi!" → 10 events:
    //   H: shift down, KeyH down, KeyH up, shift up      (0xe1, 0x0b, 0x0b, 0xe1)
    //   i: KeyI down, KeyI up                            (0x0c, 0x0c)
    //   !: shift down, Digit1 down, Digit1 up, shift up  (0xe1, 0x1e, 0x1e, 0xe1)
    const result = spawnSync("node", [CLI_PATH, "type", "Hi!", "-d", bootedUdid!], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    if (result.status !== 0) {
      throw new Error(
        `serve-sim type failed (exit=${result.status} signal=${result.signal})\nstderr: ${result.stderr}`,
      );
    }

    const logAfter = await waitForKeyLines(logFile, beforeCount + 10, 5_000);
    const newLines = logAfter.slice(logBefore.length);
    const afterCount = countKeyLines(logAfter);

    expect(afterCount - beforeCount).toBe(10);

    // Every usage we sent must show up at least once in the new log slice.
    const expectedUsages = [0xe1, 0x0b, 0x0c, 0x1e];
    for (const usage of expectedUsages) {
      const hex = usage.toString(16);
      expect(newLines).toContain(`usage=0x${hex}`);
    }

    // And we should see balanced down/up events for the new slice.
    expect(countMatches(newLines, /\[hid\] Key down /g)).toBe(5);
    expect(countMatches(newLines, /\[hid\] Key up /g)).toBe(5);
  }, 30_000);

  test.skipIf(!testDuo)("typing reaches a native text field on both Duo displays", async () => {
    await waitFor(async () => (await screenConfig()).width > 0, true);
    const original = await screenConfig();
    expect(original.supportsHingeAngle).toBe(true);
    try {
      for (const screenId of [1, 3]) {
        cli("hinge", screenId === 1 ? "fold" : "unfold", "-d", bootedUdid!);
        await waitFor(async () => (await screenConfig()).screenId, screenId);
        const start = fixtureLines().length;
        try { simctl("terminate", bootedUdid!, APP); } catch {}
        simctl("launch", bootedUdid!, APP, "--keyboard-test");
        await waitFor(() => fixtureLines().slice(start).some((line) => line.startsWith("keyboard-ready\t")), true);

        // Uppercase and punctuation exercise Shift; subsequent lower-case text
        // verifies its release. Read what the guest text field actually received.
        cli("type", "Hi! 123", "-d", bootedUdid!);
        const text = () => fixtureLines().slice(start)
          .filter((line) => line.startsWith("text\t")).at(-1)?.split("\t")[2];
        await waitFor(text, "Hi! 123");
        await sendKeyEventsToWs(state.wsUrl, [
          { type: "down", usage: 0x2a }, { type: "up", usage: 0x2a },
        ], { token: state.token });
        await waitFor(text, "Hi! 12");
        cli("type", "xy", "-d", bootedUdid!);
        await waitFor(text, "Hi! 12xy");
      }
    } finally {
      await restoreHingeState(state, original);
    }
  }, 90_000);

  test.skipIf(!testDuo)("typing cleanup restores pose and table mode", async () => {
    const initial = await screenConfig();
    try {
      for (const pose of ["book", "tent", "open"] as const) {
        await selectPose(state, pose);
        // Table Mode can also be set without a named pose.
        if (pose === "open") await selectHingeControl(state, { control: "table", value: true });
        const original = await screenConfig();
        await selectHingeControl(state, { control: "angle", value: 0 });
        await restoreHingeState(state, original);
        expect(await screenConfig()).toMatchObject({
          hingeAngle: original.hingeAngle,
          hingePose: original.hingePose,
          tableMode: original.tableMode,
        });
      }
    } finally {
      await restoreHingeState(state, initial);
    }
  }, 30_000);
});

function countKeyLines(s: string): number {
  return countMatches(s, /\[hid\] Key (down|up) /g);
}

async function waitForKeyLines(logFile: string, expectedCount: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let log = "";
  while (Date.now() < deadline) {
    log = readFileSync(logFile, "utf-8");
    if (countKeyLines(log) >= expectedCount) return log;
    await new Promise((r) => setTimeout(r, 100));
  }
  return readFileSync(logFile, "utf-8");
}

function countMatches(s: string, re: RegExp): number {
  let n = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) n++;
  return n;
}
