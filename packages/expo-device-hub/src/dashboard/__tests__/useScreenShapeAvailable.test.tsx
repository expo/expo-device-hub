import { expect, test } from "bun:test";
import { type DeviceClient } from "@expo/hub-client";
import { type Device } from "@expo/hub-components";
import { renderToStaticMarkup } from "react-dom/server";

import { useScreenShapeAvailable } from "../useScreenShapeAvailable";

function client(overrides: Partial<DeviceClient> = {}): DeviceClient {
  return {
    platform: "android",
    status: "streaming",
    screen: null,
    devices: [],
    displayCorners: null,
    ...overrides,
  } as unknown as DeviceClient;
}

function available(
  device: Pick<Device, "platform" | "model"> | undefined,
  overrides?: Partial<DeviceClient>,
) {
  function Probe() {
    return <>{String(useScreenShapeAvailable(client(overrides), device))}</>;
  }
  return renderToStaticMarkup(<Probe />) === "true";
}

test("is true for a model with a shape in the table", () => {
  expect(available({ platform: "android", model: "pixel_9_pro" })).toBe(true);
  expect(available({ platform: "ios", model: "iPhone 17 Pro" }, { platform: "ios" })).toBe(true);
});

test("is false for a model without a shape, so the screen is the whole stream rectangle", () => {
  expect(available({ platform: "android", model: "medium_phone" })).toBe(false);
  expect(
    available({ platform: "ios", model: "iPhone SE (3rd generation)" }, { platform: "ios" }),
  ).toBe(false);
  expect(available(undefined)).toBe(false);
});

test("counts the iPhone Duo's own display corners as a shape", () => {
  const displayCorners = { topLeft: 0.02, topRight: 0.15, bottomRight: 0.15, bottomLeft: 0.02 };
  expect(available({ platform: "ios", model: null }, { platform: "ios", displayCorners })).toBe(
    true,
  );
});

test("is false when the server names no model, even if the device's name matches a shape", () => {
  // A simulator that a user renamed "iPhone 17 Pro" is not an iPhone 17 Pro.
  const devices = [{ id: "sim", name: "iPhone 17 Pro", current: true }];
  expect(
    available({ platform: "ios", model: null }, {
      platform: "ios",
      devices,
    } as unknown as Partial<DeviceClient>),
  ).toBe(false);
});
