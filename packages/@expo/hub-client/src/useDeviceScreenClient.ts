import { useDeviceClientSelector } from "./DeviceClientProvider";
import type { DeviceClient, DeviceScreenClient } from "./types";

/** The screen inputs of a client. The 3D screen's client builds on the same selection. */
export function selectDeviceScreenClient(client: DeviceClient): DeviceScreenClient {
  const {
    videoKind,
    attachVideo,
    sendTouch,
    sendMultiTouch,
    cancelInput,
    sendScroll,
    sendKey,
    fold,
    pasteText,
    capabilities,
    screen,
    status,
    error,
    framePresented,
    inputError,
  } = client;
  return {
    videoKind,
    attachVideo,
    sendTouch,
    sendMultiTouch,
    cancelInput,
    sendScroll,
    sendKey,
    fold,
    pasteText,
    capabilities,
    screen,
    status,
    error,
    framePresented,
    inputError,
  } satisfies DeviceScreenClient & Record<keyof DeviceScreenClient, unknown>;
}

/** Whether two selections of a client hold the same values, property by property. */
export function equalClientSelections<Selection extends object>(
  previous: Selection,
  next: Selection,
) {
  return Object.keys(previous).every((key) =>
    Object.is(previous[key as keyof Selection], next[key as keyof Selection]),
  );
}

/** Read the SDK-owned screen inputs without subscribing to metrics, FPS, or logs. */
export function useDeviceScreenClient(): DeviceScreenClient {
  return useDeviceClientSelector(selectDeviceScreenClient, equalClientSelections);
}
