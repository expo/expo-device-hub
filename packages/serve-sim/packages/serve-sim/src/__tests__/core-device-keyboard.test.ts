import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const describeNative = process.platform === "darwin" && process.arch === "arm64" ? describe : describe.skip;

describeNative("CoreDevice keyboard bridge", () => {
  let directory: string;
  let executable: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "serve-sim-keyboard-"));
    executable = join(directory, "keyboard");
    execFileSync("xcrun", [
      "clang", "-fblocks", "-framework", "Foundation",
      "-I", join(import.meta.dir, "../../Sources/CoreDeviceShim/include"),
      join(import.meta.dir, "fixtures/core-device-keyboard.m"),
      join(import.meta.dir, "../../Sources/CoreDeviceShim/CoreDeviceDisplayShim.m"),
      "-o", executable,
    ], { timeout: 30_000, stdio: "pipe" });
  }, 30_000);

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  test.each([
    "down", "up", "send-error", "missing-symbol", "key-size", "state-size",
    "optional-size", "invalid-usage", "invalid-capability", "some-one-byte",
    "nil-one-byte", "nil-two-byte",
  ])("%s", (scenario) => {
    // Same native-fixture approach as the digitizer bridge tests. Each process
    // resolves its own simulated runtime through the production keyboard and
    // value-witness helpers, including Optional tag decoding and destruction.
    const result = spawnSync(executable, [scenario], { encoding: "utf8", timeout: 5000 });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  });
});
