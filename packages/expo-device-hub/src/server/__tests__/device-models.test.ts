import { describe, expect, test } from "bun:test";
import { type AndroidDevice } from "@expo/hub-android-utils";
import { type AppleSimulatorRuntime } from "@expo/hub-apple-utils";

import {
  androidDeviceModel,
  createAppleDeviceTypeNames,
  DEVICE_TYPE_REFRESH_MS,
} from "../device-models";

const IPHONE_17_PRO = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
const IPHONE_DUO = "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo";

function runtime(...deviceTypes: [string, string][]): AppleSimulatorRuntime {
  return {
    supportedDeviceTypes: deviceTypes.map(([identifier, name]) => ({
      identifier,
      name,
      productFamily: "iPhone",
    })),
  } as AppleSimulatorRuntime;
}

describe("createAppleDeviceTypeNames", () => {
  test("names a simulator's device type from simctl's runtimes, read once while every type is known", async () => {
    let calls = 0;
    const names = createAppleDeviceTypeNames(async () => {
      calls++;
      return { value: [runtime([IPHONE_17_PRO, "iPhone 17 Pro"], [IPHONE_DUO, "iPhone Duo"])] };
    });

    expect((await names([IPHONE_17_PRO, null])).get(IPHONE_17_PRO)).toBe("iPhone 17 Pro");
    expect((await names([IPHONE_DUO])).get(IPHONE_DUO)).toBe("iPhone Duo");
    expect(calls).toBe(1);
  });

  test("reads again for an unknown device type, at most once per refresh interval", async () => {
    let time = 0;
    let value = [runtime([IPHONE_17_PRO, "iPhone 17 Pro"])];
    let calls = 0;
    const names = createAppleDeviceTypeNames(
      async () => {
        calls++;
        return { value };
      },
      () => time,
    );

    await names([IPHONE_17_PRO]);
    value = [runtime([IPHONE_17_PRO, "iPhone 17 Pro"], [IPHONE_DUO, "iPhone Duo"])];
    // A new device type right after the last read waits for the interval.
    expect((await names([IPHONE_DUO])).get(IPHONE_DUO)).toBeUndefined();
    time += DEVICE_TYPE_REFRESH_MS;
    expect((await names([IPHONE_DUO])).get(IPHONE_DUO)).toBe("iPhone Duo");
    expect(calls).toBe(2);
  });

  test("gives no names when simctl fails, and tries again after the interval", async () => {
    let time = 0;
    let fail = true;
    const names = createAppleDeviceTypeNames(
      async () => {
        if (fail) throw new Error("simctl failed");
        return { value: [runtime([IPHONE_17_PRO, "iPhone 17 Pro"])] };
      },
      () => time,
    );

    expect((await names([IPHONE_17_PRO])).size).toBe(0);
    fail = false;
    time += DEVICE_TYPE_REFRESH_MS;
    expect((await names([IPHONE_17_PRO])).get(IPHONE_17_PRO)).toBe("iPhone 17 Pro");
  });
});

describe("androidDeviceModel", () => {
  test("is the AVD hardware profile id of an emulator and nothing for a physical device", () => {
    expect(
      androidDeviceModel({
        type: "emulator",
        config: { "hw.device.name": "pixel_9" },
      } as unknown as AndroidDevice),
    ).toBe("pixel_9");
    expect(
      androidDeviceModel({ type: "emulator", config: {} } as unknown as AndroidDevice),
    ).toBeNull();
    expect(
      androidDeviceModel({ type: "device", config: {} } as unknown as AndroidDevice),
    ).toBeNull();
  });
});
