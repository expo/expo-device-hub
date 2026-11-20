import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/devicectl-list-devices.json";
import {
  coreDeviceInfoPlist,
  gridRowForPhysical,
  parsePhysicalDevices,
  physicalStartRefusal,
  physicalDeviceUnsupportedReason,
} from "../physical-devices";

const json = JSON.stringify(fixture);

describe("parsePhysicalDevices", () => {
  test("keeps the paired phones, also with a disconnected tunnel, and drops simulators", () => {
    const devices = parsePhysicalDevices(json, "651.32");

    expect(devices).toEqual([
      {
        udid: "00008101-0000000000000001",
        name: "iPhone",
        marketingName: "iPhone 12",
        platform: "iOS",
        osVersion: "27.2.1",
        unsupportedReason: null,
      },
      expect.objectContaining({ udid: "00008101-0000000000000002" }),
      expect.objectContaining({ udid: "00008101-0000000000000003" }),
    ]);
  });

  test("drops an unpaired phone and one without Developer Mode", () => {
    const [phone] = fixture.result.devices;
    const unpaired = structuredClone(phone!);
    unpaired.properties.connection.pairingState = "unpaired";
    unpaired.connectionProperties.pairingState = "unpaired";
    const locked = structuredClone(phone!);
    locked.properties.state.developerModeStatus = { disabled: {} } as never;
    locked.deviceProperties.developerModeStatus = "disabled";

    expect(
      parsePhysicalDevices(JSON.stringify({ result: { devices: [unpaired, locked] } }), "651.32"),
    ).toEqual([]);
  });

  test("marks every phone with this Mac's missing Xcode 27", () => {
    expect(parsePhysicalDevices(json, "518.33").map((device) => device.unsupportedReason)).toEqual([
      "needs Xcode 27",
      "needs Xcode 27",
      "needs Xcode 27",
    ]);
  });

  test("returns nothing for malformed output", () => {
    expect(parsePhysicalDevices("{", "651.32")).toEqual([]);
  });
});

describe("physicalDeviceUnsupportedReason", () => {
  test("needs Xcode 27 first, then iOS 27, like the native check", () => {
    expect(physicalDeviceUnsupportedReason("26.4", "518.33")).toBe("needs Xcode 27");
    expect(physicalDeviceUnsupportedReason("26.4", "642.0")).toBe("needs iOS 27");
    expect(physicalDeviceUnsupportedReason("27.0", "641.9")).toBe("needs Xcode 27");
    expect(physicalDeviceUnsupportedReason("27.0", "642.0")).toBeNull();
  });
});

describe("gridRowForPhysical", () => {
  test("lists a phone as a booted physical row framed by its model", () => {
    const [phone] = parsePhysicalDevices(json, "651.32");

    expect(gridRowForPhysical(phone!)).toEqual({
      udid: "00008101-0000000000000001",
      name: "iPhone",
      state: "Booted",
      kind: "physical",
      chromeName: "iPhone 12",
      runtime: "iOS-27-2-1",
    });
  });

  test("carries the reason a phone cannot stream", () => {
    const [phone] = parsePhysicalDevices(json, "518.33");

    expect(gridRowForPhysical(phone!).unsupportedReason).toBe("needs Xcode 27");
  });
});

describe("coreDeviceInfoPlist", () => {
  test("is the installed CoreDevice's Info.plist unless SERVE_SIM_COREDEVICE_INFO_PLIST names another", () => {
    const installed =
      "/Library/Developer/PrivateFrameworks/CoreDevice.framework/Versions/A/Resources/Info.plist";
    expect(coreDeviceInfoPlist({})).toBe(installed);
    expect(coreDeviceInfoPlist({ SERVE_SIM_COREDEVICE_INFO_PLIST: "" })).toBe(installed);
    expect(
      coreDeviceInfoPlist({ SERVE_SIM_COREDEVICE_INFO_PLIST: "/tmp/CoreDevice-600.plist" }),
    ).toBe("/tmp/CoreDevice-600.plist");
  });
});

describe("physicalStartRefusal", () => {
  const phone = {
    udid: "00008101-0016603236F0801E",
    name: "iPhone",
    marketingName: "iPhone 12",
    platform: "iOS",
    osVersion: "27.2.1",
    unsupportedReason: "needs Xcode 27",
  };

  test("refuses a listed phone that cannot stream, with the reason the grid shows", () => {
    expect(physicalStartRefusal("00008101-0016603236f0801e", [phone])).toBe("needs Xcode 27");
  });

  test("lets a supported phone, an unlisted phone and a simulator start", () => {
    expect(physicalStartRefusal(phone.udid, [{ ...phone, unsupportedReason: null }])).toBeNull();
    expect(physicalStartRefusal(phone.udid, [])).toBeNull();
    expect(physicalStartRefusal("C485D903-49A6-4A6D-A199-7893ACF635AE", [phone])).toBeNull();
  });
});
