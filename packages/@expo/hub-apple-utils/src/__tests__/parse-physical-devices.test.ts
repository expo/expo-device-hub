import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/devicectl-list-devices.json";
import { parsePhysicalDevicesJson } from "../parse-physical-devices";
import { physicalDeviceUnsupportedReason } from "../physical-device-support";

type FixtureDevice = (typeof fixture.result.devices)[number];

const CONNECTED = "00008101-0000000000000001";
const DISCONNECTED = ["00008101-0000000000000002", "00008101-0000000000000003"];

function withDevices(devices: unknown[]): string {
  return JSON.stringify({ ...fixture, result: { devices } });
}

function phone(change: (device: FixtureDevice) => void): FixtureDevice {
  const device = structuredClone(fixture.result.devices[0]!);
  change(device);
  return device;
}

describe("parsePhysicalDevicesJson", () => {
  test("keeps the paired developer-mode phones and drops the simulators", () => {
    const devices = parsePhysicalDevicesJson(JSON.stringify(fixture)).value;

    expect(devices.map((device) => device.udid)).toEqual([CONNECTED, ...DISCONNECTED]);
    expect(devices[0]).toEqual({
      udid: CONNECTED,
      identifier: "00000001-0000-5000-8000-000000000001",
      name: "iPhone",
      marketingName: "iPhone 12",
      productType: "iPhone13,2",
      deviceType: "iPhone",
      platform: "iOS",
      osVersion: "27.2.1",
      transportType: "wired",
      connected: true,
    });
  });

  test("keeps a phone whose tunnel is disconnected, because opening it connects", () => {
    const devices = parsePhysicalDevicesJson(JSON.stringify(fixture)).value;

    expect(devices.filter((device) => !device.connected).map((device) => device.udid)).toEqual(
      DISCONNECTED,
    );
  });

  test("drops a phone that is not paired", () => {
    const unpaired = phone((device) => {
      device.properties.connection.pairingState = "unpaired";
      device.connectionProperties.pairingState = "unpaired";
    });

    expect(parsePhysicalDevicesJson(withDevices([unpaired])).value).toEqual([]);
  });

  test("drops a phone without Developer Mode", () => {
    const disabled = phone((device) => {
      device.properties.state.developerModeStatus = { disabled: { mode: 0 } } as never;
      device.deviceProperties.developerModeStatus = "disabled";
    });

    expect(parsePhysicalDevicesJson(withDevices([disabled])).value).toEqual([]);
  });

  test("keeps iPads and drops other platforms", () => {
    const ipad = phone((device) => {
      device.properties.hardware.deviceType = "iPad";
      device.properties.hardware.platform = "iPadOS";
    });
    const watch = phone((device) => {
      device.properties.hardware.deviceType = "appleWatch";
      device.properties.hardware.platform = "watchOS";
      device.hardwareProperties.platform = "watchOS";
    });

    const devices = parsePhysicalDevicesJson(withDevices([ipad, watch])).value;

    expect(devices.map((device) => device.platform)).toEqual(["iPadOS"]);
  });

  test("reads the deprecated fields when properties are missing", () => {
    const legacy = phone((device) => {
      delete (device as Partial<FixtureDevice>).properties;
    });

    expect(parsePhysicalDevicesJson(withDevices([legacy])).value).toEqual([
      expect.objectContaining({ udid: CONNECTED, osVersion: "27.2.1", connected: true }),
    ]);
  });

  test("reads properties alone, as devicectl will once the deprecated fields go", () => {
    const current = phone((device) => {
      const partial = device as Partial<FixtureDevice>;
      delete partial.hardwareProperties;
      delete partial.deviceProperties;
      delete partial.connectionProperties;
    });

    expect(parsePhysicalDevicesJson(withDevices([current])).value).toEqual([
      expect.objectContaining({ udid: CONNECTED, osVersion: "27.2.1", connected: true }),
    ]);
  });

  test("returns malformed JSON as an error", () => {
    const parsed = parsePhysicalDevicesJson("{");

    expect(parsed.value).toEqual([]);
    expect(parsed.error?.message).toContain("Failed to parse JSON");
  });
});

describe("physicalDeviceUnsupportedReason", () => {
  const [device] = parsePhysicalDevicesJson(JSON.stringify(fixture)).value;

  test("supports iOS 27 with CoreDevice 642 or newer", () => {
    expect(physicalDeviceUnsupportedReason(device!, "651.32")).toBeNull();
    expect(physicalDeviceUnsupportedReason(device!, "642")).toBeNull();
  });

  test("needs iOS 27 on the phone", () => {
    expect(physicalDeviceUnsupportedReason({ ...device!, osVersion: "26.4" }, "651.32")).toBe(
      "needs iOS 27",
    );
  });

  test("needs Xcode 27 on the Mac", () => {
    expect(physicalDeviceUnsupportedReason(device!, "518.33")).toBe("needs Xcode 27");
  });

  test("needs Xcode 27 when the CoreDevice version cannot be read", () => {
    expect(physicalDeviceUnsupportedReason(device!, null)).toBe("needs Xcode 27");
  });

  test("names the phone's requirement first", () => {
    expect(physicalDeviceUnsupportedReason({ ...device!, osVersion: "18.0" }, "518.33")).toBe(
      "needs iOS 27",
    );
  });
});
