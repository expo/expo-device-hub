import type { DeviceClient } from "./types";
import { NOOP_DEVICE_CLIENT } from "./useNoopDeviceClient";

export function createDeviceClientStore(
  initialClient: DeviceClient = NOOP_DEVICE_CLIENT,
  serverClient: DeviceClient = initialClient,
) {
  let snapshot = initialClient;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverClient,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(client: DeviceClient) {
      if (Object.is(snapshot, client)) return;
      snapshot = client;
      for (const listener of listeners) listener();
    },
  };
}

export type DeviceClientStore = ReturnType<typeof createDeviceClientStore>;
