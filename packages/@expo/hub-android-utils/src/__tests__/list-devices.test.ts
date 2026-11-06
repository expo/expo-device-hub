import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDevices } from "../list-devices";
import { clearSdkRootsCache } from "../sdk-paths";

describe("listDevices", () => {
  let sdkRoot = "";
  const previousAndroidHome = process.env.ANDROID_HOME;

  beforeAll(() => {
    sdkRoot = mkdtempSync(join(tmpdir(), "hub-list-devices-"));
    const writeTool = (path: string, script: string) => {
      mkdirSync(join(sdkRoot, path, ".."), { recursive: true });
      writeFileSync(join(sdkRoot, path), script);
      chmodSync(join(sdkRoot, path), 0o755);
    };
    writeTool("cmdline-tools/latest/bin/avdmanager", "#!/bin/sh\nexit 0\n");
    writeTool("platform-tools/adb", "#!/bin/sh\nsleep 60\n");
    process.env.ANDROID_HOME = sdkRoot;
    clearSdkRootsCache();
  });

  afterAll(() => {
    if (previousAndroidHome === undefined) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = previousAndroidHome;
    clearSdkRootsCache();
    rmSync(sdkRoot, { recursive: true, force: true });
  });

  test("gives up on a stalled adb server instead of waiting forever", async () => {
    const started = Date.now();
    const listed = await listDevices({ adbTimeoutMs: 150 });
    expect(listed.value).toEqual([]);
    expect(listed.error?.message).toBe("[android-utils] Failed to run `adb devices -l`:");
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
