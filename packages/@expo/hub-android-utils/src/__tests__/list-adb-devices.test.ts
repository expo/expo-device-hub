import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEmulatorSerial } from "../emulator";
import { listAdbDevices } from "../list-adb-devices";

describe("listAdbDevices", () => {
  let directory = "";
  let fakeAdb = "";

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "hub-list-adb-"));
    fakeAdb = join(directory, "adb.sh");
    writeFileSync(
      fakeAdb,
      [
        "#!/bin/sh",
        'if [ "$1" = devices ]; then',
        "  printf 'List of devices attached\\n'",
        "  printf 'emulator-5554 device product:sdk model:Pixel_9\\n'",
        "  printf 'emulator-5556 offline\\n'",
        "  printf 'R5CT1234ABC unauthorized usb:1-1\\n'",
        "  exit 0",
        "fi",
        'if [ "$2" = emulator-5554 ] && [ "$3" = emu ]; then printf "Pixel_9\\nOK\\n"; exit 0; fi',
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(fakeAdb, 0o755);
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("keeps every state and names only online emulators", async () => {
    expect(await listAdbDevices(fakeAdb)).toEqual({
      value: [
        { serial: "emulator-5554", state: "device", avdName: "Pixel_9" },
        { serial: "emulator-5556", state: "offline", avdName: null },
        { serial: "R5CT1234ABC", state: "unauthorized", avdName: null },
      ],
      error: null,
    });
  });

  test("turns a stalled adb devices into an error", async () => {
    const stalled = join(directory, "stalled-adb.sh");
    writeFileSync(stalled, "#!/bin/sh\nexec sleep 60\n");
    chmodSync(stalled, 0o755);

    const listed = await listAdbDevices(stalled, { timeoutMs: 100 });

    expect(listed.value).toEqual([]);
    expect(listed.error?.message).toBe("[android-utils] Failed to run `adb devices -l`:");
  });

  test("keeps an emulator whose AVD name lookup stalls", async () => {
    const stalled = join(directory, "stalled-avd-name.sh");
    writeFileSync(
      stalled,
      [
        "#!/bin/sh",
        'if [ "$1" = devices ]; then printf "List of devices attached\\nemulator-5554 device\\n"; exit 0; fi',
        "exec sleep 60",
        "",
      ].join("\n"),
    );
    chmodSync(stalled, 0o755);

    expect(await listAdbDevices(stalled, { timeoutMs: 100 })).toEqual({
      value: [{ serial: "emulator-5554", state: "device", avdName: null }],
      error: null,
    });
  });

  test("reports a missing adb as the spawn's ENOENT", async () => {
    const listed = await listAdbDevices(join(directory, "missing-adb"));

    expect(listed.value).toEqual([]);
    expect(listed.error?.error).toMatchObject({ code: "ENOENT" });
  });
});

describe("isEmulatorSerial", () => {
  test.each([
    ["emulator-5554", true],
    ["emulator-", false],
    ["R5CT1234ABC", false],
    ["192.168.1.2:5555", false],
  ])("%s is an emulator serial: %p", (serial, expected) => {
    expect(isEmulatorSerial(serial)).toBe(expected);
  });
});
