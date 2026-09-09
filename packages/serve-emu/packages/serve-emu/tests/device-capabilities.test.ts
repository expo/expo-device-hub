import { describe, expect, test } from "bun:test";
import {
  availableStreamModesForSerial,
  isEmulatorSerial,
  parseEmulatorSerial,
} from "../src/device-capabilities.ts";

describe("device capabilities", () => {
  test("recognizes adb emulator serials and exposes their console port", () => {
    expect(parseEmulatorSerial("emulator-5554")).toEqual({
      consolePort: "5554",
    });
    expect(isEmulatorSerial("emulator-5554")).toBe(true);
    expect(parseEmulatorSerial("physical-device")).toBeNull();
    expect(isEmulatorSerial("emulator-5554-extra")).toBe(false);
  });

  test("offers host screenshot streaming only to emulators", () => {
    expect(availableStreamModesForSerial("emulator-5554")).toEqual([
      "scrcpy",
      "grpc-screenshot",
    ]);
    expect(availableStreamModesForSerial("physical-device")).toEqual([
      "scrcpy",
    ]);
  });
});
