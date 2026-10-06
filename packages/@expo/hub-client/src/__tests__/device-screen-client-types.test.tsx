import { expect, test } from "bun:test";
import type { ComponentType } from "react";
import { renderToString } from "react-dom/server";

import { DeviceScreen } from "../DeviceScreen";
import { selectDeviceScreenClient } from "../device-screen-client";
import type { DeviceClient, DeviceScreenClient, DeviceScreenProps } from "../types";
import { NOOP_DEVICE_CLIENT } from "../useNoopDeviceClient";

test("custom screens keep the full client while the built-in screen accepts either input", () => {
  type ExistingProps = Omit<DeviceScreenProps, "client"> & { client: DeviceClient };
  const ExistingScreen: ComponentType<ExistingProps> = ({ client }) => (
    <span>{client.platform}</span>
  );
  // PhoneFrame and StreamPanel accept custom screens with this exported prop type.
  const InjectedScreen: ComponentType<DeviceScreenProps> = ExistingScreen;
  expect(renderToString(<InjectedScreen client={NOOP_DEVICE_CLIENT} />)).toBe("<span>ios</span>");
  const screenClient: DeviceScreenClient = selectDeviceScreenClient(NOOP_DEVICE_CLIENT);
  expect(renderToString(<DeviceScreen client={screenClient} />)).toContain("Device screen");
  expect(renderToString(<DeviceScreen client={NOOP_DEVICE_CLIENT} />)).toContain("Device screen");
});
