import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorText, execSimctl } from "../simctl";

describe("execSimctl", () => {
  let directory = "";
  let originalPath: string | undefined;

  beforeAll(() => {
    // A fake `xcrun` on PATH: `simctl stall` never returns, like a call to an
    // unresponsive CoreSimulatorService; `simctl stall-exit1` also never
    // returns, but exits 1 on SIGTERM; `simctl fail` exits non-zero.
    directory = mkdtempSync(join(tmpdir(), "hub-simctl-"));
    const xcrun = join(directory, "xcrun");
    writeFileSync(
      xcrun,
      [
        "#!/bin/sh",
        'case "$2" in',
        `  stall) echo $$ > "${join(directory, "stalled.pid")}"; exec sleep 60 ;;`,
        `  stall-exit1) trap 'kill $!; exit 1' TERM; echo $$ > "${join(directory, "stalled.pid")}"; sleep 60 & wait ;;`,
        '  fail) echo "Unable to boot device in current state: Booted" >&2; exit 1 ;;',
        '  *) echo "ok" ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(xcrun, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  });

  // 1 s leaves the fake time to write its PID file before the timeout.
  test.each(["stall", "stall-exit1"])(
    "ends a `simctl %s` call that never returns with a timeout error",
    async (command) => {
      rmSync(join(directory, "stalled.pid"), { force: true });
      const started = Date.now();
      const executed = await execSimctl([command], { timeoutMs: 1000 });

      expect(executed.value).toBeNull();
      expect(executed.error?.message).toBe(
        `[apple-utils] \`xcrun simctl ${command}\` did not respond within 1 s; CoreSimulatorService may need restarting`,
      );
      expect(Date.now() - started).toBeLessThan(4000);

      const pid = Number(readFileSync(join(directory, "stalled.pid"), "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  test.each(["stall", "stall-exit1"])(
    "does not let ignoreError hide a `simctl %s` timeout",
    async (command) => {
      const executed = await execSimctl([command], { timeoutMs: 1000, ignoreError: () => true });

      expect(executed.error?.message).toContain("did not respond within 1 s");
    },
  );

  test("reports an ordinary failure with the failure message", async () => {
    const executed = await execSimctl(["fail"], { timeoutMs: 5000 });

    expect(executed.value).toBeNull();
    expect(executed.error?.message).toBe("[apple-utils] Failed to run `xcrun simctl fail`:");
  });

  test("still lets ignoreError accept a benign failure", async () => {
    const executed = await execSimctl(["fail"], {
      ignoreError: (error) => errorText(error).includes("current state: Booted"),
    });

    expect(executed).toEqual({ value: null, error: null });
  });
});
