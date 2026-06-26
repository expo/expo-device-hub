import { describe, expect, test } from "bun:test";
import { assertDevice, buildCreateAvdArgs } from "../avdmanager";

const OPTIONS = {
  name: "expo-emu-host-0",
  package: "system-images;android-36.1;google_apis_playstore;arm64-v8a",
  device: "pixel_6",
};

describe("assertDevice", () => {
  test("throws on an empty or whitespace device", () => {
    expect(() => assertDevice("")).toThrow(/device/);
    expect(() => assertDevice("   ")).toThrow(/device/);
  });

  test("accepts a non-empty device", () => {
    expect(() => assertDevice("pixel_6")).not.toThrow();
  });
});

describe("buildCreateAvdArgs", () => {
  test("maps options to `avdmanager create avd` flags in order", () => {
    expect(buildCreateAvdArgs(OPTIONS)).toEqual([
      "create",
      "avd",
      "--name",
      "expo-emu-host-0",
      "--package",
      "system-images;android-36.1;google_apis_playstore;arm64-v8a",
      "--device",
      "pixel_6",
    ]);
  });

  test("appends --force last when force is true", () => {
    const args = buildCreateAvdArgs({ ...OPTIONS, force: true });
    expect(args.at(-1)).toBe("--force");
  });

  test("omits --force by default and when false", () => {
    expect(buildCreateAvdArgs(OPTIONS)).not.toContain("--force");
    expect(buildCreateAvdArgs({ ...OPTIONS, force: false })).not.toContain("--force");
  });

  test("throws when device is empty or whitespace", () => {
    expect(() =>
      buildCreateAvdArgs({ ...OPTIONS, device: undefined as unknown as string }),
    ).toThrow(/device/);
    expect(() => buildCreateAvdArgs({ ...OPTIONS, device: "" })).toThrow(/device/);
    expect(() => buildCreateAvdArgs({ ...OPTIONS, device: "   " })).toThrow(/device/);
  });
});
