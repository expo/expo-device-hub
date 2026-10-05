import type { DeviceClient } from "./types";
import { NOOP_DEVICE_CLIENT } from "./useNoopDeviceClient";

function sameValues(previous: DeviceClient, next: DeviceClient): boolean {
  if (Object.getPrototypeOf(previous) !== Object.getPrototypeOf(next)) return false;
  const keys = Reflect.ownKeys(previous);
  if (keys.length !== Reflect.ownKeys(next).length) return false;
  return keys.every(
    (key) => Object.hasOwn(next, key) && Object.is(Reflect.get(previous, key), Reflect.get(next, key)),
  );
}

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
      // A provider render can rebuild a client with the same values. Keeping the old
      // snapshot stops useSyncExternalStore from rendering every consumer again.
      if (Object.is(snapshot, client) || sameValues(snapshot, client)) return;
      snapshot = client;
      for (const listener of listeners) listener();
    },
  };
}

export type DeviceClientStore = ReturnType<typeof createDeviceClientStore>;
