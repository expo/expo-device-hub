import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("uses software rendering when requested", () => {
    const args = buildEmulatorArgs({ name: "x", port: 5556 }, "software");
    expect(args[args.indexOf("-gpu") + 1]).toBe("software");
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

  test("formats a software rendering command", () => {
    const command = formatEmulatorCommand("/sdk/emulator", { name: "x", port: 5554 }, "software");
    expect(command).toContain("-gpu software");
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

  test("retries with software rendering when hardware rendering is unavailable", async () => {
    const invocations = join(dir, "invocations.txt");
    const emulator = join(dir, "emulator");
    writeFileSync(
      emulator,
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const gpuIndex = process.argv.indexOf("-gpu");
const gpuMode = process.argv[gpuIndex + 1];
appendFileSync(${JSON.stringify(invocations)}, gpuMode + "\\n");
if (gpuMode === "host") {
  console.error("ERROR | Your GPU cannot be used for hardware rendering. Consider using software rendering.");
  setTimeout(() => process.exit(1), 1_000);
} else {
  setTimeout(() => process.exit(0), 20);
}
`,
    );
    chmodSync(emulator, 0o755);

    const spawned = await spawnEmulator(emulator, { name: "x", port: 5554 });
    expect(spawned.error).toBeNull();
    expect(spawned.value).not.toBeNull();
    expect(await spawned.value!.exited).toEqual({ code: 0, signal: null, error: null });
    expect(spawned.value!.gpuMode).toBe("software");
    expect(readFileSync(invocations, "utf8")).toBe("host\nsoftware\n");
  });
});
