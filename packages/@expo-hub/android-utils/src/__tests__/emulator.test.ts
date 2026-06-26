import { describe, expect, test } from "bun:test";
import { buildEmulatorArgs, emulatorSerial } from "../emulator";

describe("emulatorSerial", () => {
  test("formats the adb serial from the console port", () => {
    expect(emulatorSerial(5554)).toBe("emulator-5554");
  });
});

describe("buildEmulatorArgs", () => {
  test("builds a headless boot command for the avd and port", () => {
    expect(buildEmulatorArgs({ name: "expo-emu-host-0", port: 5554 })).toEqual([
      "-avd",
      "expo-emu-host-0",
      "-no-window",
      "-no-audio",
      "-gpu",
      "auto-no-window",
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
