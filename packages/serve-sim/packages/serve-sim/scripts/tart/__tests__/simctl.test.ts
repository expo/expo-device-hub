import { describe, expect, test } from "bun:test";
import { parseSimctlDevices, pickAvailableNamed, pickBootedIphone, pickBootedNamed } from "../simctl";

const listing = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      {
        udid: "AAAA-1",
        name: "iPhone 17",
        state: "Shutdown",
        isAvailable: true,
      },
      {
        udid: "BBBB-2",
        name: "iPhone 16",
        state: "Booted",
        isAvailable: true,
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [
      {
        udid: "CCCC-3",
        name: "Apple Watch",
        state: "Booted",
        isAvailable: true,
      },
    ],
  },
});

describe("parseSimctlDevices", () => {
  test("flattens runtimes", () => {
    expect(parseSimctlDevices(listing).map((device) => device.udid)).toEqual(["AAAA-1", "BBBB-2", "CCCC-3"]);
  });

  test("prefers a booted iPhone over a watch", () => {
    expect(pickBootedIphone(parseSimctlDevices(listing))).toBe("BBBB-2");
  });

  test("prefers a booted device with the requested name", () => {
    const json = JSON.stringify({
      devices: {
        ios: [
          { udid: "AAAA-1", name: "iPhone 17", state: "Booted", isAvailable: true },
          { udid: "BBBB-2", name: "iPhone 16", state: "Booted", isAvailable: true },
        ],
      },
    });
    expect(pickBootedNamed(parseSimctlDevices(json), "iPhone 17")).toBe("AAAA-1");
  });

  test("does not treat a shutdown requested name as booted", () => {
    expect(pickBootedNamed(parseSimctlDevices(listing), "iPhone 17")).toBeNull();
  });

  test("picks an available named device", () => {
    expect(pickAvailableNamed(parseSimctlDevices(listing), "iPhone 17")).toBe("AAAA-1");
  });

  test("skips unavailable names", () => {
    const json = JSON.stringify({
      devices: {
        ios: [{ udid: "X", name: "iPhone 17", state: "Shutdown", isAvailable: false }],
      },
    });
    expect(pickAvailableNamed(parseSimctlDevices(json), "iPhone 17")).toBeNull();
  });
});
