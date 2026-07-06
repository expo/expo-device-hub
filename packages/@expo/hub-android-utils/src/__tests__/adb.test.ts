import { describe, expect, test } from "bun:test";
import { buildEmuKillArgs } from "../adb";

describe("buildEmuKillArgs", () => {
  test("targets the serial and kills the emulator", () => {
    expect(buildEmuKillArgs("emulator-5554")).toEqual(["-s", "emulator-5554", "emu", "kill"]);
  });
});
