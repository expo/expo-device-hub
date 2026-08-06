import { describe, expect, test } from "bun:test";
import { parseRuntimes } from "../parse-runtimes";

const RUNTIMES_JSON = JSON.stringify({
  runtimes: [
    {
      buildversion: "21A328",
      platform: "iOS",
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
      version: "17.0",
      isAvailable: true,
      name: "iOS 17.0",
      supportedDeviceTypes: [
        {
          name: "iPhone 15",
          identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
          productFamily: "iPhone",
        },
        {
          name: "iPad Pro (11-inch)",
          identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch",
          productFamily: "iPad",
        },
        // No identifier → dropped.
        { name: "Mystery", productFamily: "iPhone" },
      ],
    },
    {
      buildversion: "21J351",
      platform: "tvOS",
      identifier: "com.apple.CoreSimulator.SimRuntime.tvOS-17-0",
      version: "17.0",
      isAvailable: false,
      name: "tvOS 17.0",
    },
  ],
});

describe("parseRuntimes", () => {
  test("returns every runtime in order", () => {
    expect(parseRuntimes(RUNTIMES_JSON).value.map((r) => r.identifier)).toEqual([
      "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
      "com.apple.CoreSimulator.SimRuntime.tvOS-17-0",
    ]);
  });

  test("maps the curated fields, reading the lowercase buildversion key", () => {
    const [first] = parseRuntimes(RUNTIMES_JSON).value;
    expect(first).toEqual({
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
      name: "iOS 17.0",
      version: "17.0",
      buildVersion: "21A328",
      platform: "iOS",
      isAvailable: true,
      supportedDeviceTypes: [
        {
          identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
          name: "iPhone 15",
          productFamily: "iPhone",
        },
        {
          identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch",
          name: "iPad Pro (11-inch)",
          productFamily: "iPad",
        },
      ],
    });
  });

  test("drops supported device types without an identifier", () => {
    expect(parseRuntimes(RUNTIMES_JSON).value[0]?.supportedDeviceTypes).toHaveLength(2);
  });

  test("defaults supportedDeviceTypes to an empty array when absent or not an array", () => {
    expect(parseRuntimes(RUNTIMES_JSON).value[1]?.supportedDeviceTypes).toEqual([]);

    const json = JSON.stringify({ runtimes: [{ identifier: "x", supportedDeviceTypes: {} }] });
    expect(parseRuntimes(json).value[0]?.supportedDeviceTypes).toEqual([]);
  });

  test("keeps unavailable and non-iOS runtimes, preserving their flags", () => {
    const tvos = parseRuntimes(RUNTIMES_JSON).value[1];
    expect(tvos?.platform).toBe("tvOS");
    expect(tvos?.isAvailable).toBe(false);
  });

  test("defaults isAvailable to false when absent or not a boolean", () => {
    const json = JSON.stringify({ runtimes: [{ identifier: "x", isAvailable: "true" }] });
    expect(parseRuntimes(json).value[0]?.isAvailable).toBe(false);
  });

  test("drops entries without an identifier", () => {
    const json = JSON.stringify({ runtimes: [{ name: "No id" }, { identifier: "keep" }] });
    expect(parseRuntimes(json).value.map((r) => r.identifier)).toEqual(["keep"]);
  });

  test("returns an empty array when runtimes is missing or not an array", () => {
    expect(parseRuntimes(JSON.stringify({})).value).toEqual([]);
    expect(parseRuntimes(JSON.stringify({ runtimes: {} })).value).toEqual([]);
  });

  test("returns an empty array and the malformed JSON error", () => {
    const parsed = parseRuntimes("{ not json");
    expect(parsed.value).toEqual([]);
    expect(parsed.error).not.toBeNull();
  });
});
