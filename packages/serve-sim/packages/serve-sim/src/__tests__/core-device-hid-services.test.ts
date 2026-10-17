import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const describeNative =
  process.platform === "darwin" && process.arch === "arm64" ? describe : describe.skip;

describeNative("CoreDevice HID service setup", () => {
  let directory: string;
  let executable: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "serve-sim-hid-services-"));
    executable = join(directory, "hid-services");
    execFileSync(
      "xcrun",
      [
        "swiftc",
        "-swift-version",
        "5",
        "-parse-as-library",
        join(import.meta.dir, "../../Sources/SimNative/CoreDeviceHIDServices.swift"),
        join(import.meta.dir, "../../Sources/StreamingPolicy/HIDInputSetup.swift"),
        join(import.meta.dir, "fixtures/core-device-hid-services.swift"),
        "-o",
        executable,
      ],
      { timeout: 30_000, stdio: "pipe" },
    );
  }, 30_000);

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  test.each([
    "ready",
    "keyboard-failure",
    "transient-keyboard",
    "touch-failure",
    "cancelled-retry",
  ])("%s", (scenario) => {
    const result = spawnSync(executable, [scenario], { encoding: "utf8", timeout: 5000 });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  });
});
