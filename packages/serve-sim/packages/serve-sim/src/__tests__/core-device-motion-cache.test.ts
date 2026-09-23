import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const describeNative = process.platform === "darwin" && process.arch === "arm64" ? describe : describe.skip;

describeNative("CoreDevice motion symbol cache", () => {
  let directory: string;
  let executable: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "serve-sim-motion-cache-"));
    executable = join(directory, "motion-cache");
    execFileSync("xcrun", [
      "clang", "-fblocks",
      "-I", join(import.meta.dir, "../../Sources/CoreDeviceShim/include"),
      join(import.meta.dir, "fixtures/core-device-motion-cache.c"),
      "-o", executable,
    ], { timeout: 30_000, stdio: "pipe" });
  }, 30_000);

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  test.each([
    { scenario: "available", calls: "1 5 256" },
    { scenario: "missing-symbol", calls: "1 5 0" },
    { scenario: "missing-framework", calls: "1 0 0" },
  ])("caches $scenario without resolving again or rewriting the descriptor", ({ scenario, calls }) => {
    expect(execFileSync(executable, [scenario], { encoding: "utf8", timeout: 5000 }).trim()).toBe(calls);
  });
});
