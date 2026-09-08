import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEmuKillArgs, runAdbDevices } from "../adb";

describe("buildEmuKillArgs", () => {
  test("targets the serial and kills the emulator", () => {
    expect(buildEmuKillArgs("emulator-5554")).toEqual(["-s", "emulator-5554", "emu", "kill"]);
  });
});

describe("runAdbDevices", () => {
  let stalledAdb = "";
  let directory = "";

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "hub-adb-"));
    stalledAdb = join(directory, "stalled-adb.sh");
    writeFileSync(stalledAdb, "#!/bin/sh\nsleep 60\n");
    chmodSync(stalledAdb, 0o755);
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("kills a stalled adb once timeoutMs elapses", async () => {
    const started = Date.now();
    const listed = await runAdbDevices(stalledAdb, { timeoutMs: 150 });
    expect(listed.value).toBeNull();
    expect(listed.error?.message).toBe("[android-utils] Failed to run `adb devices -l`:");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("kills a stalled adb as soon as the signal aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const listed = await runAdbDevices(stalledAdb, { signal: controller.signal });
    expect(listed.value).toBeNull();
    expect(listed.error).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
