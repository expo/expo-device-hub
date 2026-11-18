import { type DeviceClient } from "@expo/hub-client";
import { useScreenShape } from "@expo/hub-client/shapes";
import { type Device } from "@expo/hub-components";

/**
 * Whether the selected device has a known screen shape: a table shape for its
 * model, by the same lookup as the screen's `DeviceShape`, or the iPhone Duo's
 * own display corners. Without one, the screen shows the whole stream
 * rectangle and the "Show device shape" option is disabled. A device whose
 * model the server cannot name has no shape: like `PhoneFrame`, the lookup
 * passes an empty model, so it never falls back to the client's device name.
 */
// @ref LLP 0017#hub-dashboard — the shape option is disabled for a device without a known shape
export function useScreenShapeAvailable(
  client: DeviceClient,
  device: Pick<Device, "platform" | "model"> | undefined,
): boolean {
  const shape = useScreenShape({ client, platform: device?.platform, model: device?.model ?? "" });
  return shape !== null || !!client.displayCorners;
}
