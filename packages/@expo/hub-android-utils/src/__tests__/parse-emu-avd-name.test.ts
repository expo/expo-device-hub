import { describe, expect, test } from "bun:test";
import { parseEmuAvdName } from "../parse-emu-avd-name";

describe("parseEmuAvdName", () => {
  test("returns the AVD name before the OK status line", () => {
    expect(parseEmuAvdName("Medium_Phone_API_36.1\nOK\n")).toBe("Medium_Phone_API_36.1");
  });

  test("trims surrounding whitespace", () => {
    expect(parseEmuAvdName("  Pixel_6_API_34  \r\nOK\r\n")).toBe("Pixel_6_API_34");
  });

  test("returns null on a KO error reply", () => {
    expect(parseEmuAvdName("KO: unknown command\n")).toBeNull();
    expect(parseEmuAvdName("KO\n")).toBeNull();
  });

  test("returns null when there is no name", () => {
    expect(parseEmuAvdName("OK\n")).toBeNull();
    expect(parseEmuAvdName("")).toBeNull();
    expect(parseEmuAvdName(null)).toBeNull();
  });
});
