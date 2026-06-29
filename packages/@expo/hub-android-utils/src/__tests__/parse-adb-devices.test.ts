import { describe, expect, test } from "bun:test";
import { isOnline, parseAdbDevices } from "../parse-adb-devices";

const ADB_DEVICES_OUTPUT = `List of devices attached
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
27151JEGR11854         device usb:1-1 product:bluejay model:Pixel_6a device:bluejay transport_id:3
`;

describe("parseAdbDevices", () => {
  test("parses each attached device's serial and state", () => {
    const devices = parseAdbDevices(ADB_DEVICES_OUTPUT);
    expect(devices.map((d) => d.serial)).toEqual(["emulator-5554", "27151JEGR11854"]);
    expect(devices.map((d) => d.state)).toEqual(["device", "device"]);
  });

  test("parses the trailing key:value fields", () => {
    const [emulator] = parseAdbDevices(ADB_DEVICES_OUTPUT);
    expect(emulator?.fields).toEqual({
      product: "sdk_gphone64_arm64",
      model: "sdk_gphone64_arm64",
      device: "emu64a",
      transport_id: "1",
    });
  });

  test("ignores the header, daemon messages and blank lines", () => {
    const output = `* daemon not running; starting now at tcp:5037
* daemon started successfully
List of devices attached

emulator-5554          device transport_id:1
`;
    expect(parseAdbDevices(output).map((d) => d.serial)).toEqual(["emulator-5554"]);
  });

  test("keeps non-online states like offline and unauthorized", () => {
    const output = `List of devices attached
emulator-5554          offline transport_id:1
abc123                 unauthorized usb:1-2 transport_id:2
`;
    expect(parseAdbDevices(output).map((d) => d.state)).toEqual(["offline", "unauthorized"]);
  });

  test("returns an empty array when nothing is attached", () => {
    expect(parseAdbDevices("List of devices attached\n")).toEqual([]);
    expect(parseAdbDevices("")).toEqual([]);
  });
});

describe("isOnline", () => {
  test("is true only for the 'device' state", () => {
    expect(isOnline({ serial: "x", state: "device", fields: {} })).toBe(true);
    expect(isOnline({ serial: "x", state: "offline", fields: {} })).toBe(false);
    expect(isOnline({ serial: "x", state: "unauthorized", fields: {} })).toBe(false);
  });
});
