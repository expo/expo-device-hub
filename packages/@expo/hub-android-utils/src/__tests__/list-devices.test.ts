import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDevices } from "../list-devices";
import { clearSdkRootsCache } from "../sdk-paths";

const STALL = "sleep 60";
const ONE_DEVICE = 'printf "List of devices attached\\nR58M123 device usb:1-1 model:Pixel\\n"';

describe("listDevices", () => {
  let sdkRoot = "";
  const previousAndroidHome = process.env.ANDROID_HOME;

  const writeTool = (path: string, body: string) => {
    mkdirSync(join(sdkRoot, path, ".."), { recursive: true });
    writeFileSync(join(sdkRoot, path), `#!/bin/sh\n${body}\n`);
    chmodSync(join(sdkRoot, path), 0o755);
  };

  /** A fake `adb` that answers `devices -l` with `devices` and runs `shell` for everything else. */
  const writeAdb = (devices: string, shell: string) =>
    writeTool("platform-tools/adb", `if [ "$1" = devices ]; then ${devices}; else ${shell}; fi`);

  beforeEach(() => {
    sdkRoot = mkdtempSync(join(tmpdir(), "hub-list-devices-"));
    writeTool("cmdline-tools/latest/bin/avdmanager", "exit 0");
    process.env.ANDROID_HOME = sdkRoot;
    clearSdkRootsCache();
  });

  afterEach(() => {
    if (previousAndroidHome === undefined) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = previousAndroidHome;
    clearSdkRootsCache();
    rmSync(sdkRoot, { recursive: true, force: true });
  });

  const expectGivesUp = async (message: string) => {
    const started = Date.now();
    const listed = await listDevices({ timeoutMs: 500 });
    expect(listed.value).toEqual([]);
    expect(listed.error?.message).toBe(message);
    expect(Date.now() - started).toBeLessThan(3000);
  };

  test("gives up on a stalled adb server instead of waiting forever", async () => {
    writeAdb(STALL, "exit 0");
    await expectGivesUp("[android-utils] Failed to run `adb devices -l`:");
  });

  test("gives up on a stalled avdmanager", async () => {
    writeTool("cmdline-tools/latest/bin/avdmanager", STALL);
    writeAdb(ONE_DEVICE, "exit 0");
    await expectGivesUp("[android-utils] Failed to run `avdmanager list avd`:");
  });

  test("gives up on a device whose getprop stalls", async () => {
    writeAdb(ONE_DEVICE, STALL);
    await expectGivesUp("[android-utils] Failed to read getprop for R58M123:");
  });
});
