/**
 * The client of the 3D screen: the limited part of a device client that
 * `DeviceModelScreen` reads, as `DeviceScreenClient` is for the flat
 * `DeviceScreen`. This module does not import three.js.
 */

import { useDeviceClientSelector } from "../DeviceClientProvider";
import { type DeviceClient, type DeviceScreenClient } from "../types";
import { equalClientSelections, selectDeviceScreenClient } from "../useDeviceScreenClient";

// @ref LLP 0019#screen-client — the 3D screen reads a named part of the client, as the flat screen does
/**
 * What {@link DeviceModelScreen} reads from a device client: the inputs of the
 * flat `DeviceScreen`, the separate displays of a foldable, and the device's
 * orientation. A full `DeviceClient` fits. The type keeps the 3D screen from
 * reading another property, such as metrics or logs, by accident.
 */
export type DeviceModelScreenClient = DeviceScreenClient &
  Pick<DeviceClient, "displays" | "orientation">;

/** The 3D screen's part of a client. Exported for the test of what the screen reads. */
export function selectDeviceModelScreenClient(client: DeviceClient): DeviceModelScreenClient {
  const { displays, orientation } = client;
  return { ...selectDeviceScreenClient(client), displays, orientation };
}

/**
 * Read the inputs of {@link DeviceModelScreen} without subscribing to metrics,
 * FPS, or logs, as `useDeviceScreenClient` does for the flat screen. The result
 * also fits `DeviceScreen` and `deviceModelStreamable`, so one call serves the
 * 3D screen and its flat fallback.
 */
export function useDeviceModelScreenClient(): DeviceModelScreenClient {
  return useDeviceClientSelector(selectDeviceModelScreenClient, equalClientSelections);
}
