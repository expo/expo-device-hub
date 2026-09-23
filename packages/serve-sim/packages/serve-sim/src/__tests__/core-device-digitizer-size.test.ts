import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const describeNative = process.platform === "darwin" && process.arch === "arm64" ? describe : describe.skip;

describeNative("CoreDevice digitizer runtime sizes", () => {
  let directory: string;
  let executable: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "serve-sim-digitizer-size-"));
    executable = join(directory, "digitizer-size");
    execFileSync("xcrun", [
      "clang", "-fblocks", "-framework", "Foundation",
      "-I", join(import.meta.dir, "../../Sources/CoreDeviceShim/include"),
      join(import.meta.dir, "fixtures/core-device-digitizer-size.m"),
      "-o", executable,
    ], { timeout: 30_000, stdio: "pipe" });
  }, 30_000);

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  test.each([
    { report: 16, contact: 16, available: true },
    { report: 24, contact: 16, available: false },
    { report: 16, contact: 24, available: false },
    { report: 8, contact: 16, available: false },
    { report: 16, contact: 8, available: false },
  ])("report=$report contact=$contact available=$available", ({ report, contact, available }) => {
    // Each process gets a fresh dispatch_once, like a new server encountering
    // a different Xcode version. Rejected layouts must also reject touch calls.
    const result = spawnSync(executable, [String(report), String(contact)], { encoding: "utf8", timeout: 5000 });
    expect({ status: result.status, stderr: result.stderr, stdout: result.stdout.trim() }).toEqual({
      status: 0,
      stderr: "",
      stdout: available ? "available" : "unavailable",
    });
  });
});
