import { useDeviceClientSelector } from "./DeviceClientProvider";
import type { DeviceClient, DeviceScreenClient } from "./types";

function selectDeviceScreenClient(client: DeviceClient): DeviceScreenClient {
  const {
    videoKind,
    attachVideo,
    sendTouch,
    sendMultiTouch,
    sendScroll,
    sendKey,
    hinge,
    screen,
    status,
    error,
  } = client;
  return {
    videoKind,
    attachVideo,
    sendTouch,
    sendMultiTouch,
    sendScroll,
    sendKey,
    hinge,
    screen,
    status,
    error,
  } satisfies DeviceScreenClient & Record<keyof DeviceScreenClient, unknown>;
}

function equalScreenClients(previous: DeviceScreenClient, next: DeviceScreenClient) {
  return Object.keys(previous).every((key) =>
    Object.is(previous[key as keyof DeviceScreenClient], next[key as keyof DeviceScreenClient]),
  );
}

/** Read the SDK-owned screen inputs without subscribing to metrics, FPS, or logs. */
export function useDeviceScreenClient(): DeviceScreenClient {
  return useDeviceClientSelector(selectDeviceScreenClient, equalScreenClients);
}
