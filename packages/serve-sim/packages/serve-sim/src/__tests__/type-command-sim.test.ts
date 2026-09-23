import { e2eDevice } from "./e2e-preconditions";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync, spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { stateDir } from "../state";
import { parseDetachState } from "./detach-state";
import { freePortAsync } from "./helpers";

/**
 * Native e2e for `serve-sim type`.
 *
 * Boots through the full stack: textToKeyEvents → WS 0x06 frames →
 * SimStreamHelper.ClientManager → HIDInjector.sendKey → CoreSimulator's HID
 * legacy client. The helper logs `[hid] Key <down|up> usage=0x<hex>` for every
 * accepted key event, which is what we assert against — proving the event
 * round-tripped all the way to the sim, not just to the helper's WS reader.
 *
 * Those per-event HID logs are gated behind `SERVE_SIM_DEBUG_HID` (they otherwise
 * flood stdout), so the server is started with that env set to make them visible.
 *
 * Skipped automatically when no iOS simulator is booted, so this stays green
 * on machines without one. The macOS CI job boots a sim explicitly and runs
 * `bun test packages/serve-sim/src/__tests__/`, so it runs there.
 */

const CLI_PATH = join(import.meta.dir, "../../src/index.ts");

const bootedUdid = e2eDevice();
const describeWithSim = bootedUdid ? describe : describe.skip;

describeWithSim(`serve-sim type e2e (booted sim ${bootedUdid ?? "<skipped>"})`, () => {
  let logFile: string;

  beforeAll(async () => {
    try { execSync(`bun run ${CLI_PATH} --kill ${bootedUdid}`, { stdio: "pipe" }); } catch {}

    const startPort = await freePortAsync();
    const detach = spawnSync("bun", ["run", CLI_PATH, "--detach", "-p", String(startPort), bootedUdid!], {
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
    const state = parseDetachState<{ device: string }>(detach.stdout);
    logFile = join(stateDir(), `server-${state.device}.log`);
  }, 180_000);

  afterAll(() => {
    try { execSync(`bun run ${CLI_PATH} --kill ${bootedUdid}`, { stdio: "pipe" }); } catch {}
  });

  test("`serve-sim type` injects HID key events into the booted simulator", async () => {
    const logBefore = readFileSync(logFile, "utf-8");
    const beforeCount = countKeyLines(logBefore);

    // "Hi!" → 10 events:
    //   H: shift down, KeyH down, KeyH up, shift up      (0xe1, 0x0b, 0x0b, 0xe1)
    //   i: KeyI down, KeyI up                            (0x0c, 0x0c)
    //   !: shift down, Digit1 down, Digit1 up, shift up  (0xe1, 0x1e, 0x1e, 0xe1)
    const result = spawnSync("bun", ["run", CLI_PATH, "type", "Hi!", "-d", bootedUdid!], {
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
