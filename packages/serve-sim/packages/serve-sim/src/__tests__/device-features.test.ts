import { describe, expect, test } from "bun:test";
import {
  DEVICE_FEATURES,
  buttonFeature,
  deviceKindOf,
  deviceFeatureRefusal,
  helperRouteFeature,
  routeFeature,
  unavailableDeviceFeatures,
} from "../device-features";
import { hostActionFeature } from "../host-actions";

const PHONE = "00008101-0016603236F0801E";
const OLD_PHONE = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SIMULATOR = "C485D903-49A6-4A6D-A199-7893ACF635AE";

describe("deviceKindOf", () => {
  test("a hardware UDID is a physical device", () => {
    expect(deviceKindOf(PHONE)).toBe("physical");
    expect(deviceKindOf(PHONE.toLowerCase())).toBe("physical");
    expect(deviceKindOf(OLD_PHONE)).toBe("physical");
  });

  test("a CoreSimulator UUID or a simulator name is a simulator", () => {
    expect(deviceKindOf(SIMULATOR)).toBe("simulator");
    expect(deviceKindOf("iPhone 17 Pro")).toBe("simulator");
    expect(deviceKindOf("booted")).toBe("simulator");
  });
});

describe("buttonFeature", () => {
  test("every device has Home; other buttons are hardware buttons", () => {
    expect(buttonFeature("home")).toBeNull();
    expect(buttonFeature("swipe_home")).toBeNull();
    expect(buttonFeature("lock")).toBe("hardwareButtons");
    expect(buttonFeature(undefined)).toBe("hardwareButtons");
    expect(deviceFeatureRefusal(PHONE, buttonFeature("lock"))).toBe(
      "Hardware buttons other than Home are not available on a physical device.",
    );
    expect(deviceFeatureRefusal(SIMULATOR, buttonFeature("lock"))).toBeNull();
  });
});

describe("unavailableDeviceFeatures", () => {
  test("a simulator has every feature", () => {
    expect(unavailableDeviceFeatures(SIMULATOR)).toEqual({});
  });

  test("a physical device has none of the simulator features, each with a reason", () => {
    const unavailable = unavailableDeviceFeatures(PHONE);

    expect(Object.keys(unavailable).sort()).toEqual(Object.keys(DEVICE_FEATURES).sort());
    expect(unavailable.clipboard).toBe("Clipboard is not available on a physical device.");
    expect(unavailable.location).toBe("Location is not available on a physical device.");
  });

  test("lists the gated features", () => {
    expect(Object.keys(DEVICE_FEATURES).sort()).toEqual([
      "accessibility",
      "activity",
      "appInjection",
      "apps",
      "clipboard",
      "deviceSettings",
      "devtools",
      "foregroundApp",
      "hardwareButtons",
      "hinge",
      "lifecycle",
      "location",
      "logs",
      "permissions",
      "rotate",
    ]);
  });
});

describe("deviceFeatureRefusal", () => {
  test("refuses a physical device and nothing for a simulator or an ungated route", () => {
    expect(deviceFeatureRefusal(PHONE, "logs")).toBe(
      "Device logs and crash reports are not available on a physical device.",
    );
    expect(deviceFeatureRefusal(SIMULATOR, "logs")).toBeNull();
    expect(deviceFeatureRefusal(PHONE, null)).toBeNull();
    expect(deviceFeatureRefusal(null, "logs")).toBeNull();
  });
});

describe("routeFeature", () => {
  test.each([
    ["/api/pasteboard", "clipboard"],
    ["/api/apps/icon", "apps"],
    ["/logs", "logs"],
    ["/crashes", "logs"],
    ["/crashes/abc", "logs"],
    ["/ax", "accessibility"],
    ["/metrics", "activity"],
    ["/appstate", "foregroundApp"],
    ["/network-capture", "appInjection"],
    ["/network-capture.har", "appInjection"],
    ["/network-capture/abc", "appInjection"],
    ["/devtools", "devtools"],
    ["/devtools/highlight", "devtools"],
    ["/grid/api/shutdown", "lifecycle"],
  ])("%s needs %s", (path, feature) => {
    expect(routeFeature(path)).toBe(feature as never);
  });

  test.each([
    "/api",
    "/api/screenshot",
    "/api/events",
    "/api/event-log",
    "/api/event-log/events",
    "/grid/api",
    "/grid/api/start",
    "/healthz",
  ])("%s works on every device", (path) => {
    expect(routeFeature(path)).toBeNull();
  });
});

describe("helperRouteFeature", () => {
  test.each([
    ["/ax", "accessibility"],
    ["/foreground", "foregroundApp"],
    ["/camera/status", "appInjection"],
    ["/panel/1/stream.mjpeg", "hinge"],
  ])("%s needs %s", (path, feature) => {
    expect(helperRouteFeature(path)).toBe(feature as never);
  });

  test.each([
    "/stream.mjpeg",
    "/stream.avcc",
    "/stream-settings",
    "/config",
    "/health",
    "/webrtc/offer",
    "/webrtc/close",
    "/webrtc/stats",
    "/recording/video",
    "/ws",
  ])("%s works on every device", (path) => {
    expect(helperRouteFeature(path)).toBeNull();
  });
});

describe("hostActionFeature", () => {
  test.each([
    ["clipboard.paste", "clipboard"],
    ["appearance.set", "deviceSettings"],
    ["textSize.get", "deviceSettings"],
    ["settings.status", "deviceSettings"],
    ["home.springboard", "deviceSettings"],
    ["hinge.set", "hinge"],
    ["rotate", "rotate"],
    ["permissions.set", "permissions"],
    ["location.set", "location"],
    ["camera.inject", "appInjection"],
    ["capture.enable", "appInjection"],
    ["app.install", "apps"],
    ["app.launch", "apps"],
    ["app.file.read", "apps"],
    ["media.add", "apps"],
  ])("%s needs %s", (action, feature) => {
    expect(hostActionFeature(action)).toBe(feature as never);
  });

  test.each(["tap", "gesture", "type", "button", "screenshot.capture", "actions.describe"])(
    "%s works on every device",
    (action) => {
      expect(hostActionFeature(action)).toBeNull();
    },
  );
});
