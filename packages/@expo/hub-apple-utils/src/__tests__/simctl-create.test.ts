import { describe, expect, test } from "bun:test";
import { assertCreateOptions, buildCreateArgs, parseCreatedUdid } from "../simctl-create";

const OPTIONS = {
  name: "expo-sim-host-0",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
};

describe("assertCreateOptions", () => {
  test("throws on an empty or whitespace name", () => {
    expect(() => assertCreateOptions({ ...OPTIONS, name: "" })).toThrow(/name/);
    expect(() => assertCreateOptions({ ...OPTIONS, name: "   " })).toThrow(/name/);
  });

  test("throws on an empty or whitespace deviceType", () => {
    expect(() => assertCreateOptions({ ...OPTIONS, deviceType: "" })).toThrow(/deviceType/);
    expect(() => assertCreateOptions({ ...OPTIONS, deviceType: "   " })).toThrow(/deviceType/);
  });

  test("accepts options without a runtime", () => {
    expect(() => assertCreateOptions({ name: "n", deviceType: "d" })).not.toThrow();
  });
});

describe("buildCreateArgs", () => {
  test("maps options to positional `simctl create` args", () => {
    expect(buildCreateArgs(OPTIONS)).toEqual([
      "create",
      "expo-sim-host-0",
      "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
      "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
    ]);
  });

  test("omits the runtime when not provided or empty", () => {
    expect(buildCreateArgs({ name: "n", deviceType: "d" })).toEqual(["create", "n", "d"]);
    expect(buildCreateArgs({ ...OPTIONS, runtime: "   " })).toEqual([
      "create",
      "expo-sim-host-0",
      "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
    ]);
  });

  test("throws when a required field is empty", () => {
    expect(() => buildCreateArgs({ ...OPTIONS, name: "" })).toThrow(/name/);
    expect(() => buildCreateArgs({ ...OPTIONS, deviceType: "" })).toThrow(/deviceType/);
  });
});

describe("parseCreatedUdid", () => {
  test("trims the UDID simctl prints", () => {
    expect(parseCreatedUdid("ABCDEF01-2345-6789-ABCD-EF0123456789\n")).toBe(
      "ABCDEF01-2345-6789-ABCD-EF0123456789",
    );
  });

  test("returns null for empty or whitespace-only output", () => {
    expect(parseCreatedUdid("")).toBeNull();
    expect(parseCreatedUdid("  \n")).toBeNull();
  });
});
