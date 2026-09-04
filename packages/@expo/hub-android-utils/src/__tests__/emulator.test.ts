import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEmulatorArgs,
  emulatorSerial,
  formatEmulatorCommand,
  spawnEmulator,
} from "../emulator";

describe("emulatorSerial", () => {
  test("formats the adb serial from the console port", () => {
    expect(emulatorSerial(5554)).toBe("emulator-5554");
  });
});

describe("buildEmulatorArgs", () => {
  test("builds the boot command for the avd and port", () => {
    expect(buildEmulatorArgs({ name: "expo-emu-host-0", port: 5554 })).toEqual([
      "-avd",
      "expo-emu-host-0",
      "-no-audio",
      "-no-window",
      "-gpu",
      "auto",
      "-no-boot-anim",
      "-port",
      "5554",
    ]);
  });

  test("stringifies the port for -port", () => {
    const args = buildEmulatorArgs({ name: "x", port: 5556 });
    expect(args[args.indexOf("-port") + 1]).toBe("5556");
  });

  test("appends extraArgs verbatim after the port", () => {
    const args = buildEmulatorArgs({
      name: "x",
      port: 5554,
      extraArgs: ["-camera-back", "imagefile:/tmp/a.png"],
    });
    expect(args.slice(-4)).toEqual(["-port", "5554", "-camera-back", "imagefile:/tmp/a.png"]);
  });

  test("adds nothing when extraArgs is empty or omitted", () => {
    const plain = buildEmulatorArgs({ name: "x", port: 5554 });
    expect(buildEmulatorArgs({ name: "x", port: 5554, extraArgs: [] })).toEqual(plain);
    expect(plain.at(-1)).toBe("5554");
  });
});

describe("formatEmulatorCommand", () => {
  test("joins the binary and boot args into a runnable command", () => {
    const command = formatEmulatorCommand("/sdk/emulator/emulator", { name: "x", port: 5556 });
    expect(command.startsWith("/sdk/emulator/emulator ")).toBe(true);
    expect(command).toContain("-port 5556");
  });

  test("includes the extra args", () => {
    const command = formatEmulatorCommand("/sdk/emulator/emulator", {
      name: "x",
      port: 5554,
      extraArgs: ["-camera-back", "imagefile:/tmp/a.png"],
    });
    expect(command.endsWith("-port 5554 -camera-back imagefile:/tmp/a.png")).toBe(true);
  });

  test("quotes parts containing whitespace", () => {
    const command = formatEmulatorCommand("/my sdk/emulator", { name: "x", port: 5554 });
    expect(command.startsWith('"/my sdk/emulator"')).toBe(true);
  });
});

describe("spawnEmulator", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-emulator-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns null when the binary does not exist", async () => {
    const spawned = await spawnEmulator(join(dir, "missing"), { name: "x", port: 5554 });
    expect(spawned.value).toBeNull();
    expect(spawned.error?.message).toBe("[android-utils] Failed to spawn `emulator`:");
  });
});
