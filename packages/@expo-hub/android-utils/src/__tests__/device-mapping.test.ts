import { describe, expect, test } from "bun:test";
import {
  type ConnectedDevice,
  indexBootedEmulators,
  toBootedEmulatorDevice,
  toEmulatorDevice,
  toPhysicalDevice,
} from "../device-mapping";

const emulator = (avdName: string | null, serial: string): ConnectedDevice => ({
  serial,
  isEmulator: true,
  avdName,
  properties: { "ro.kernel.qemu": "1" },
});

const physical = (serial: string, properties: Record<string, string>): ConnectedDevice => ({
  serial,
  isEmulator: false,
  avdName: null,
  properties,
});

describe("indexBootedEmulators", () => {
  test("maps each booted emulator's AVD name to its serial", () => {
    const index = indexBootedEmulators([
      emulator("Pixel_6", "emulator-5554"),
      physical("27151JEGR11854", {}),
    ]);
    expect(index.get("Pixel_6")).toBe("emulator-5554");
    expect(index.size).toBe(1);
  });

  test("ignores emulators without a resolved AVD name", () => {
    expect(indexBootedEmulators([emulator(null, "emulator-5554")]).size).toBe(0);
  });

  test("keeps the first serial when an AVD name appears twice", () => {
    const index = indexBootedEmulators([
      emulator("Pixel_6", "emulator-5554"),
      emulator("Pixel_6", "emulator-5556"),
    ]);
    expect(index.get("Pixel_6")).toBe("emulator-5554");
  });
});

describe("toEmulatorDevice", () => {
  const block = { Name: "Pixel_6", Path: "/avd/Pixel_6.avd", Device: "pixel_6 (Google)" };

  test("marks the AVD booted when a serial is provided", () => {
    const device = toEmulatorDevice(block, { AvdId: "Pixel_6" }, "emulator-5554");
    expect(device).toEqual({
      name: "Pixel_6",
      type: "emulator",
      booted: true,
      serial: "emulator-5554",
      path: "/avd/Pixel_6.avd",
      properties: block,
      config: { AvdId: "Pixel_6" },
    });
  });

  test("marks the AVD not booted when serial is null", () => {
    const device = toEmulatorDevice(block, {}, null);
    expect(device.booted).toBe(false);
    expect(device.serial).toBeNull();
  });

  test("tolerates missing Name and Path", () => {
    const device = toEmulatorDevice({}, {}, null);
    expect(device.name).toBe("");
    expect(device.path).toBeNull();
  });
});

describe("toBootedEmulatorDevice", () => {
  test("builds a booted emulator entry from the AVD name", () => {
    expect(toBootedEmulatorDevice(emulator("Pixel_6", "emulator-5554"))).toEqual({
      name: "Pixel_6",
      type: "emulator",
      booted: true,
      serial: "emulator-5554",
      path: null,
      properties: {},
      config: {},
    });
  });

  test("falls back to the serial when the AVD name is unknown", () => {
    expect(toBootedEmulatorDevice(emulator(null, "emulator-5554")).name).toBe("emulator-5554");
  });
});

describe("toPhysicalDevice", () => {
  test("describes a connected physical device from its curated props", () => {
    const device = toPhysicalDevice(
      physical("27151JEGR11854", {
        "ro.product.model": "Pixel 6a",
        "ro.product.manufacturer": "Google",
        "ro.build.version.release": "17",
        "ro.build.version.sdk": "37",
        "ro.build.display.id": "CP2A.260605.012",
        "persist.sys.timezone": "Europe/Berlin",
      }),
    );
    expect(device).toEqual({
      name: "Pixel 6a",
      type: "device",
      booted: true,
      serial: "27151JEGR11854",
      path: null,
      properties: {
        "ro.product.model": "Pixel 6a",
        "ro.product.manufacturer": "Google",
        "ro.build.version.release": "17",
        "ro.build.version.sdk": "37",
        "ro.build.display.id": "CP2A.260605.012",
      },
      config: {},
    });
  });

  test("falls back to the serial when the model is unknown", () => {
    expect(toPhysicalDevice(physical("27151JEGR11854", {})).name).toBe("27151JEGR11854");
  });
});
