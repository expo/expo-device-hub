import { useDeviceClientSelector } from "./DeviceClientProvider";
import { equalScreenClients, selectDeviceScreenClient } from "./device-screen-client";
import type { DeviceScreenClient } from "./types";

/** Read the SDK-owned screen inputs without subscribing to metrics, FPS, or logs. */
export function useDeviceScreenClient(): DeviceScreenClient {
  return useDeviceClientSelector(selectDeviceScreenClient, equalScreenClients);
}
