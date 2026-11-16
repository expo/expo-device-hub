import { type AndroidDevice, type AndroidDeviceProfile } from "@expo/hub-android-utils";
import { describe, expect, test } from "bun:test";

import {
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
  test.each([
    ["pixel_10_pro", "Pixel 10 Pro"],
    ["pixel_9", "Pixel 9"],
    ["pixel_fold", "Pixel Fold"],
    ["pixel_9_pro_fold", "Pixel 9 Pro Fold"],
    ["pixel_10_pro_fold", "Pixel 10 Pro Fold"],
    ["small_phone", "Small Phone"],
    ["medium_phone", "Medium Phone"],
  ])("supports phone profile %s by id or display name", (id, name) => {
    expect(isSupportedAndroidDeviceProfile(profile(id, name))).toBe(true);
    expect(isSupportedAndroidDeviceProfile(profile(id, ""))).toBe(true);
    expect(isSupportedAndroidDeviceProfile(profile("", name))).toBe(true);
    for (const metadata of [id, `${id} (${id.startsWith("pixel") ? "Google" : "Generic"})`]) {
      expect(
        isSupportedAndroidDevice(androidDevice({ config: { "hw.device.name": metadata } })),
      ).toBe(true);
      expect(isSupportedAndroidDevice(androidDevice({ properties: { Device: metadata } }))).toBe(
        true,
      );
    }
  });

  test.each([
    ["pixel_tablet", "Pixel Tablet", null],
    ["pixel_c", "Pixel C", null],
    ["pixel_buds", "Pixel Buds", null],
    ["pixel_watch", "Pixel Watch", "android-wear"],
    ["small_tablet", "Small Tablet", null],
    ["medium_tablet", "Medium Tablet", null],
    ["tv_1080p", "Television (1080p)", "android-tv"],
    ["wearos_large_round", "Wear OS Large Round", "android-wear"],
    ["automotive_portrait", "Automotive Portrait", "android-automotive"],
    ["desktop_large", "Large Desktop", "android-desktop"],
    ["resizable", "Resizable (Experimental)", null],
    ["7.6in Foldable", '7.6" Fold-in with outer display', null],
    ["Nexus 5", "Nexus 5", null],
    // Not present in the verified SDK profile list; do not invent support for it.
    ["large_phone", "Large Phone", null],
  ])("keeps unrelated or unknown profile %s unsupported", (id, name, tag) => {
    expect(isSupportedAndroidDeviceProfile(profile(id, name, tag))).toBe(false);
    expect(isSupportedAndroidDevice(androidDevice({ config: { "hw.device.name": id } }))).toBe(
      false,
    );
    expect(
      isSupportedAndroidDevice(androidDevice({ properties: { Device: `${id} (Generic)` } })),
    ).toBe(false);
  });

  test("does not allow phone names to override specialized profile tags", () => {
    expect(isSupportedAndroidDeviceProfile(profile("pixel_fold", "Pixel Fold", "android-tv"))).toBe(
      false,
    );
    expect(
      isSupportedAndroidDeviceProfile(profile("medium_phone", "Medium Phone", "android-wear")),
    ).toBe(false);
  });

  test("classifies known AVDs from their profile metadata", () => {
    expect(
      isSupportedAndroidDevice(androidDevice({ config: { "hw.device.name": "pixel_10_pro" } })),
    ).toBe(true);
    expect(
      isSupportedAndroidDevice(
        androidDevice({
          name: "Pixel_9",
          properties: { Device: "medium_tablet (Generic)" },
        }),
      ),
    ).toBe(false);
  });

  test("uses hardware metadata before an AVD name, preserving Pixel name fallback", () => {
    expect(isSupportedAndroidDevice(androidDevice({ name: "Pixel_9_API_36" }))).toBe(true);
    expect(
      isSupportedAndroidDevice(
        androidDevice({
          name: "Pixel_9",
          config: { "hw.device.name": "medium_tablet" },
          properties: { Device: "pixel_fold (Google)" },
        }),
      ),
    ).toBe(false);
    expect(
      isSupportedAndroidDevice(
        androidDevice({
          name: "My_Custom_AVD",
          config: { "hw.device.name": "medium_phone" },
          properties: { Device: "medium_tablet (Generic)" },
        }),
      ),
    ).toBe(true);
    expect(
      isSupportedAndroidDevice(
        androidDevice({
          properties: { Device: " Small_Phone (Generic) " },
        }),
      ),
    ).toBe(true);
    expect(
      isSupportedAndroidDevice(
        androidDevice({
          config: { "hw.device.name": "medium_phone_tablet" },
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
