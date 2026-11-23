import { type AndroidDevice, type AndroidDeviceProfile } from "@expo/hub-android-utils";
import { describe, expect, test } from "bun:test";

import {
  androidDevice3DModel,
  appleDevice3DModel,
  isSupportedAndroidDevice,
  isSupportedAndroidDeviceProfile,
  isSupportedAppleDevice,
  isSupportedAppleDeviceType,
} from "../device-support";

describe("iOS device support", () => {
  test("supports iPhone device types, not iPad", () => {
    const iphone17Pro = {
      identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
    };
    const iphone16Pro = {
      identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
    };
    const ipad = { identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4" };

    expect(isSupportedAppleDeviceType(iphone17Pro)).toBe(true);
    expect(isSupportedAppleDeviceType(iphone16Pro)).toBe(true);
    expect(isSupportedAppleDeviceType(ipad)).toBe(false);
  });

  test("classifies existing simulators from their device type identifier", () => {
    expect(
      isSupportedAppleDevice({
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      }),
    ).toBe(true);
    expect(
      isSupportedAppleDevice({
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
      }),
    ).toBe(true);
    expect(
      isSupportedAppleDevice({
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4",
      }),
    ).toBe(false);
    expect(isSupportedAppleDevice({ deviceTypeIdentifier: null })).toBe(false);
  });
});

describe("Android device support", () => {
  test("supports Pixel phone profiles, not foldables, tablets, or wearables", () => {
    expect(isSupportedAndroidDeviceProfile(profile("pixel_10_pro", "Pixel 10 Pro"))).toBe(true);
    expect(isSupportedAndroidDeviceProfile(profile("pixel_9", "Pixel 9"))).toBe(true);
    expect(isSupportedAndroidDeviceProfile(profile("pixel_9_pro_fold", "Pixel 9 Pro Fold"))).toBe(
      false,
    );
    expect(isSupportedAndroidDeviceProfile(profile("pixel_fold", "Pixel Fold"))).toBe(false);
    expect(isSupportedAndroidDeviceProfile(profile("pixel_tablet", "Pixel Tablet"))).toBe(false);
    expect(isSupportedAndroidDeviceProfile(profile("pixel_c", "Pixel C"))).toBe(false);
    expect(isSupportedAndroidDeviceProfile(profile("medium_phone", "Medium Phone"))).toBe(false);
    expect(
      isSupportedAndroidDeviceProfile(profile("pixel_watch", "Pixel Watch", "android-wear")),
    ).toBe(false);
    expect(isSupportedAndroidDeviceProfile(profile("pixel_buds", "Pixel Buds"))).toBe(false);
  });

  test("classifies known AVDs from their profile metadata", () => {
    expect(
      isSupportedAndroidDevice(androidDevice({ config: { "hw.device.name": "pixel_10_pro" } })),
    ).toBe(true);
    expect(
      isSupportedAndroidDevice(
        androidDevice({
          name: "Pixel_9",
          properties: { Device: "medium_phone (Generic)" },
        }),
      ),
    ).toBe(false);
  });

  test("supports all physical Android devices", () => {
    expect(
      isSupportedAndroidDevice(
        androidDevice({ type: "device", properties: { "ro.product.model": "Pixel 9 Pro" } }),
      ),
    ).toBe(true);
    expect(
      isSupportedAndroidDevice(
        androidDevice({ type: "device", properties: { "ro.product.model": "Galaxy S25" } }),
      ),
    ).toBe(true);
    expect(isSupportedAndroidDevice(androidDevice({ type: "device" }))).toBe(true);
  });

  test("treats unknown Android emulators as untested", () => {
    expect(isSupportedAndroidDevice(androidDevice())).toBe(false);
  });
});

describe("3D device models", () => {
  test("picks a simulator's model from its device type identifier", () => {
    const model = (deviceTypeIdentifier: string | null) =>
      appleDevice3DModel({ deviceTypeIdentifier });
    expect(model("com.apple.CoreSimulator.SimDeviceType.iPhone-Duo")).toBe("ios:iphone-duo");
    expect(model("com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro")).toBe("ios:iphone-18-pro");
    // Close relatives have no model and keep the flat preview.
    expect(model("com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro-Max")).toBeNull();
    expect(model("com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro")).toBeNull();
    expect(model(null)).toBeNull();
  });

  test("picks an emulator's model from its hardware profile, not its AVD name", () => {
    const model = (config: Record<string, string>, name = "Test_Device") =>
      androidDevice3DModel(androidDevice({ name, config }));
    expect(model({ "hw.device.name": "pixel_9_pro" })).toBe("android:pixel-9-pro");
    expect(model({ "hw.device.name": "pixel_9_pro_fold" })).toBe("android:pixel-9-pro-fold");
    expect(model({ "hw.device.name": "pixel_9_pro_xl" })).toBeNull();
    expect(model({ "hw.device.name": "pixel_9" })).toBeNull();
    expect(model({ "hw.device.name": "medium_phone" }, "Pixel_9_Pro_API_36_1")).toBeNull();
    // Without profile metadata, an AVD named like a model still gets none.
    expect(model({}, "Pixel_9_Pro")).toBeNull();
    expect(model({}, "Pixel_9_Pro_Fold")).toBeNull();
  });

  test("picks a physical Android device's model from its product model", () => {
    const model = (productModel: string) =>
      androidDevice3DModel(
        androidDevice({ type: "device", properties: { "ro.product.model": productModel } }),
      );
    expect(model("Pixel 9 Pro")).toBe("android:pixel-9-pro");
    expect(model("Pixel 9 Pro Fold")).toBe("android:pixel-9-pro-fold");
    expect(model("Galaxy S25")).toBeNull();
  });
});

function profile(id: string, name: string, tag: string | null = null): AndroidDeviceProfile {
  return { id, name, tag, index: null, oem: null };
}

function androidDevice(overrides: Partial<AndroidDevice> = {}): AndroidDevice {
  return {
    name: "Test_Device",
    type: "emulator",
    booted: true,
    serial: "emulator-5554",
    path: null,
    lastBootedAt: null,
    properties: {},
    config: {},
    ...overrides,
  };
}
