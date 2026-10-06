import type { DeviceClient, DeviceScreenClient } from './types';

/** Flatten the stream and input values that DeviceScreen reads. */
export function selectDeviceScreenClient(client: DeviceClient): DeviceScreenClient {
  const { stream, sendTouch, sendMultiTouch, sendScroll, sendKey } = client;
  return {
    videoKind: stream.videoKind,
    attachVideo: stream.attachVideo,
    status: stream.status,
    screen: stream.data?.screen ?? null,
    error: stream.error?.message ?? null,
    sendTouch,
    sendMultiTouch,
    sendScroll,
    sendKey,
  } satisfies DeviceScreenClient & Record<keyof DeviceScreenClient, unknown>;
}

export function equalScreenClients(previous: DeviceScreenClient, next: DeviceScreenClient) {
  return Object.keys(previous).every((key) =>
    Object.is(previous[key as keyof DeviceScreenClient], next[key as keyof DeviceScreenClient]),
  );
}

/** Accept a full client or the flattened screen inputs. */
export function asDeviceScreenClient(client: DeviceClient | DeviceScreenClient): DeviceScreenClient {
  return 'stream' in client ? selectDeviceScreenClient(client) : client;
}
