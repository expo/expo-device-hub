import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const describeNative = process.platform === "darwin" && process.arch === "arm64" ? describe : describe.skip;

describeNative("CoreDevice digitizer edge gestures", () => {
  let directory: string;
  let executable: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "serve-sim-digitizer-report-"));
    executable = join(directory, "digitizer-report");
    execFileSync("xcrun", [
      "clang", "-fblocks", "-framework", "Foundation",
      "-I", join(import.meta.dir, "../../Sources/CoreDeviceShim/include"),
      join(import.meta.dir, "fixtures/core-device-digitizer-report.m"),
      "-o", executable,
    ], { timeout: 30_000, stdio: "pipe" });
  }, 30_000);

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function report(edge: number, touching: boolean, count = 1) {
    return execFileSync(executable, [String(edge), touching ? "1" : "0", String(count)], {
      encoding: "utf8", timeout: 5000,
    }).trim().split(" ").map(Number);
  }

  test.each([1, 2, 3, 4])("edge %i locks the inward swipe through touch-up", (edge) => {
    const edgeFlags = 0x10 | (1 << (edge - 1));
    expect(report(edge, true)).toEqual([0x103, edgeFlags | 0x60, 1]);
    expect(report(edge, false)).toEqual([0x103, edgeFlags, 1]);
  });

  test.each([1, 2])("ordinary %i-finger gestures remain unlocked and release every contact", (count) => {
    expect(report(0, true, count)).toEqual([0x103, count === 1 ? 0x60 : 0x6060, count]);
    expect(report(0, false, count)).toEqual([0x103, 0, count]);
  });
});
