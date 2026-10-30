import { expect, test } from "bun:test";
import { parsePhysicalDevices } from "../physical-devices";

test("discovers iPhones and iPads without treating remembered devices as connected", () => {
  const device = (modelCode: string, available: boolean, connection = "usb") => ({
    simulator: false,
    platform: "com.apple.platform.iphoneos",
    modelCode,
    identifier: modelCode,
    name: "Renamed device",
    operatingSystemVersion: "27.2 (24B119)",
    available,
    interface: connection,
  });
  const devices = parsePhysicalDevices(
    JSON.stringify([
      device("iPhone17,1", true),
      device("iPad16,6", true, "network"),
      device("iPhone16,1", false),
      device("Watch7,1", true),
      { ...device("iPhone19,2", true), simulator: true },
    ]),
  );
  expect(devices.map(({ udid, connected }) => [udid, connected])).toEqual([
    ["iPhone17,1", true],
    ["iPad16,6", true],
    ["iPhone16,1", false],
  ]);
  expect(devices[0]).toMatchObject({ kind: "iPhone", transport: "usb", osVersion: "27.2" });
  expect(devices[1]).toMatchObject({ kind: "iPad", transport: "wifi" });
});

test("rejects invalid discovery output", () => {
  expect(() => parsePhysicalDevices("{}")).toThrow("Invalid Xcode device list");
  expect(() => parsePhysicalDevices("not json")).toThrow();
});
