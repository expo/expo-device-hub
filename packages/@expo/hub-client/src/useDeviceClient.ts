import { useContext, useMemo, useSyncExternalStore } from "react";

import { DeviceClientStoreContext } from "./DeviceClientProvider";
import type { DeviceClientStore } from "./device-client-store";
import type { DeviceClient } from "./types";

function createTrackedClient(store: DeviceClientStore) {
  // Keep reads across renders so conditional and interrupted renders cannot lose a subscription.
  const properties = new Set<keyof DeviceClient>();
  const presenceChecks = new Set<PropertyKey>();
  const ownPresenceChecks = new Set<PropertyKey>();
  let trackAll = false;

  function getPresenceSnapshot(client: DeviceClient, property: PropertyKey) {
    const latest = store.getSnapshot();
    // Presence checks must agree with callback reads from retained clients.
    return typeof Reflect.get(client, property) === "function" ||
      typeof Reflect.get(latest, property) === "function"
      ? latest
      : client;
  }

  return {
    subscribe(listener: () => void) {
      let previous = store.getSnapshot();
      return store.subscribe(() => {
        const next = store.getSnapshot();
        const changed =
          trackAll ||
          [...properties].some((key) => !Object.is(previous[key], next[key])) ||
          [...presenceChecks].some(
            (key) => Reflect.has(previous, key) !== Reflect.has(next, key),
          ) ||
          [...ownPresenceChecks].some(
            (key) => Object.hasOwn(previous, key) !== Object.hasOwn(next, key),
          );
        previous = next;
        if (changed) listener();
      });
    },
    track(client: DeviceClient): DeviceClient {
      return new Proxy(client, {
        get(target, property, receiver) {
          if (typeof property === "string") properties.add(property as keyof DeviceClient);
          const value = Reflect.get(target, property, receiver);
          const latest = Reflect.get(store.getSnapshot(), property);
          // Handlers may retain a client from before a connection or callback update.
          // Include both values so optional callbacks also follow additions and removals.
          return typeof value === "function" || typeof latest === "function" ? latest : value;
        },
        has(target, property) {
          presenceChecks.add(property);
          return Reflect.has(getPresenceSnapshot(target, property), property);
        },
        getOwnPropertyDescriptor(target, property) {
          ownPresenceChecks.add(property);
          return Reflect.getOwnPropertyDescriptor(getPresenceSnapshot(target, property), property);
        },
        ownKeys(target) {
          // Enumeration also subscribes to optional properties that a later backend may provide.
          trackAll = true;
          return Reflect.ownKeys(target);
        },
      });
    },
  };
}

/** Read or destructure client properties without subscribing to unread values. */
export function useDeviceClient(): DeviceClient {
  const store = useContext(DeviceClientStoreContext);
  if (!store) {
    throw new Error(
      "useDeviceClient requires a DeviceClientProvider. Wrap this component in a provider to share its device connection.",
    );
  }
  const tracked = useMemo(() => createTrackedClient(store), [store]);
  const client = useSyncExternalStore(
    tracked.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  return useMemo(() => tracked.track(client), [tracked, client]);
}
