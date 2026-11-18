import { type DeviceClient } from "@expo/hub-client";
import { type ScreenShape, useScreenShape } from "@expo/hub-client/shapes";
import { type Device } from "@expo/hub-components";

export type DeviceScreenShape = {
  /**
   * The table shape for the device's model as the viewer sees it, by the same
   * lookup as the screen's `DeviceShape`. It is known before the stream
   * connects, so it gives the frame its proportions and the loading glow its
   * corners.
   */
  shape: ScreenShape | null;
  /**
   * Whether the device has a known screen shape: a table shape, or the iPhone
   * Duo's own display corners. Without one, the screen shows the whole stream
   * rectangle and the "Show device shape" option is disabled.
   */
  available: boolean;
};

/**
 * The screen shape of the selected device. A device whose model the server
 * cannot name has no shape: like `PhoneFrame`, the lookup passes an empty
 * model, so it never falls back to the client's device name.
 */
// @ref LLP 0017#hub-dashboard — the shape option is disabled for a device without a known shape
export function useDeviceScreenShape(
  client: DeviceClient,
  device: Pick<Device, "platform" | "model"> | undefined,
): DeviceScreenShape {
  const shape = useScreenShape({ client, platform: device?.platform, model: device?.model ?? "" });
  return { shape, available: shape !== null || !!client.displayCorners };
}
