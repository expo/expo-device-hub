import { type ApplePhysicalDeviceListing } from "@expo/hub-apple-utils";
import { describe, expect, test } from "bun:test";

import { deviceListFingerprint } from "../device-list-websocket";
import { physicalIosHubDevice } from "../physical-ios-devices";

const iphone: ApplePhysicalDeviceListing = {
  udid: "00008101-0000000000000001",
  identifier: "00000001-0000-5000-8000-000000000001",
  name: "iPhone",
  marketingName: "iPhone 12",
  productType: "iPhone13,2",
  deviceType: "iPhone",
  platform: "iOS",
  osVersion: "27.2.1",
  transportType: "wired",
  connected: false,
  unsupportedReason: null,
};

describe("physicalIosHubDevice", () => {
  test("lists a paired iPhone as a booted physical device under its hardware UDID", () => {
    expect(physicalIosHubDevice(iphone)).toEqual({
      id: "00008101-0000000000000001",
      name: "iPhone",
      version: "iOS 27.2.1",
      platform: "ios",
      booted: true,
      physical: true,
      supported: true,
      model: "iPhone 12",
      deviceModel: null,
    });
  });

  test("marks a phone that cannot stream unsupported, with the reason", () => {
    expect(physicalIosHubDevice({ ...iphone, unsupportedReason: "needs iOS 27" })).toMatchObject({
      supported: false,
      unsupportedReason: "needs iOS 27",
    });
  });

  test("leaves an iPad unsupported, like an iPad simulator", () => {
    expect(
      physicalIosHubDevice({ ...iphone, deviceType: "iPad", platform: "iPadOS" }),
    ).toMatchObject({ supported: false, version: "iPadOS 27.2.1" });
  });
});

describe("deviceListFingerprint", () => {
  test("changes when a device's unsupported reason changes", () => {
    const list = (reason: string | null) => ({
      simulators: [physicalIosHubDevice({ ...iphone, unsupportedReason: reason })],
      emulators: [],
    });

    expect(deviceListFingerprint(list("needs iOS 27"))).not.toBe(
      deviceListFingerprint(list("needs Xcode 27")),
    );
  });
});
