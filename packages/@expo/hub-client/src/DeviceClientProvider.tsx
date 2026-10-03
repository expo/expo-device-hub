import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/with-selector";

import { createDeviceClientStore, type DeviceClientStore } from "./device-client-store";
import type { DeviceClient, DeviceConnectionOptions, DevicePlatform } from "./types";
import { useAndroidDeviceClient } from "./useAndroidDevice";
import { useIosDeviceClient } from "./useIosDevice";
import { NOOP_DEVICE_CLIENT } from "./useNoopDeviceClient";

export const DeviceClientStoreContext = createContext<DeviceClientStore | null>(null);

export type DeviceClientProviderProps = {
  platform: DevicePlatform | null;
  options: DeviceConnectionOptions;
  children: ReactNode;
};

/** Own one connection while children subscribe to individual client values. */
export function DeviceClientProvider({ platform, options, children }: DeviceClientProviderProps) {
  const ios = useIosDeviceClient({
    ...options,
    enabled: platform === "ios" && options.enabled !== false,
  });
  const android = useAndroidDeviceClient({
    ...options,
    enabled: platform === "android" && options.enabled !== false,
  });
  const client = platform === "ios" ? ios : platform === "android" ? android : NOOP_DEVICE_CLIENT;
  const [store] = useState(() => {
    // Hydration must start with the same idle media even when WebCodecs is browser-only.
    const serverClient: DeviceClient = platform
      ? { ...NOOP_DEVICE_CLIENT, platform, videoKind: platform === "android" ? "canvas" : "img" }
      : NOOP_DEVICE_CLIENT;
    return createDeviceClientStore(client, serverClient);
  });

  useLayoutEffect(() => {
    store.publish(client);
  }, [store, client]);
  return (
    <DeviceClientStoreContext.Provider value={store}>{children}</DeviceClientStoreContext.Provider>
  );
}

/** Subscribe to a client value. Object selections can supply their own equality function. */
export function useDeviceClientSelector<Selection>(
  selector: (client: DeviceClient) => Selection,
  isEqual: (previous: Selection, next: Selection) => boolean = Object.is,
): Selection {
  const store = useContext(DeviceClientStoreContext);
  if (!store) {
    throw new Error(
      "useDeviceClientSelector requires a DeviceClientProvider. Wrap this component in a provider to share its device connection.",
    );
  }
  return useSyncExternalStoreWithSelector(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
    selector,
    isEqual,
  );
}
