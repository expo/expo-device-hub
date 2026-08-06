import { describe, expect, test } from "bun:test";
import { parseDevicesJson } from "../parse-devices";

describe("parseDevicesJson", () => {
  test("flattens the runtime device arrays and adds runtime metadata", () => {
    const json = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [
          {
            udid: "A",
            name: "KWPhone",
            state: "Booted",
            isAvailable: true,
            deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
          },
          { udid: "B", name: "iPad", state: "Shutdown", isAvailable: true },
        ],
        "com.apple.CoreSimulator.SimRuntime.tvOS-18-5": [
          { udid: "C", name: "Apple TV", state: "Shutdown", isAvailable: false },
        ],
      },
    });

    const devices = parseDevicesJson(json).value;

    expect(devices).toHaveLength(3);
    expect(devices[0]).toMatchObject({
      udid: "A",
      name: "KWPhone",
      state: "Booted",
      isAvailable: true,
      runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
      platform: "iOS",
      osVersion: "18.6",
    });
    expect(devices[2]).toMatchObject({ platform: "tvOS", osVersion: "18.5" });
  });

  test("returns an empty array when there are no devices", () => {
    expect(parseDevicesJson(JSON.stringify({ devices: {} })).value).toEqual([]);
  });

  test("returns an empty array when devices is missing", () => {
    expect(parseDevicesJson(JSON.stringify({ pairs: {} })).value).toEqual([]);
  });

  test("returns an empty array when devices is not an object", () => {
    expect(parseDevicesJson(JSON.stringify({ devices: [] })).value).toEqual([]);
  });

  test("drops malformed runtime groups, non-object entries, and entries without a UDID", () => {
    const json = JSON.stringify({
      devices: {
        malformed: [{ udid: "A" }, { name: "no udid" }, null, 7, "x"],
        "not-an-array": { udid: "B" },
      },
    });
    expect(parseDevicesJson(json).value).toHaveLength(1);
  });

  test("returns an empty array and the malformed JSON error", () => {
    const parsed = parseDevicesJson("{ not json");
    expect(parsed.value).toEqual([]);
    expect(parsed.error).not.toBeNull();
  });
});
