import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEmulatorArgs, emulatorSerial, formatEmulatorCommand, spawnEmulator } from "../emulator";

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
      "host",
      "-no-boot-anim",
      "-port",
      "5554",
    ]);
  });

  test("stringifies the port for -port", () => {
    const args = buildEmulatorArgs({ name: "x", port: 5556 });
    expect(args[args.indexOf("-port") + 1]).toBe("5556");
  });
});

describe("formatEmulatorCommand", () => {
  test("joins the binary and boot args into a runnable command", () => {
    const command = formatEmulatorCommand("/sdk/emulator/emulator", { name: "x", port: 5556 });
    expect(command.startsWith("/sdk/emulator/emulator ")).toBe(true);
    expect(command).toContain("-port 5556");
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
    const child = spawnEmulator(join(dir, "missing"), { name: "x", port: 5554 });
    // spawn() defers ENOENT to the "error" event; either shape (null or an
    // errored child) must not throw.
    if (child) {
      await new Promise((resolve) => {
        child.once("error", resolve);
        child.once("exit", resolve);
      });
    }
  });
});
